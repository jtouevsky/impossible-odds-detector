// AI engines for the in-app analyst. Tried in order; the first that is available answers:
//
//   1. Claude, via the Claude Code CLI you are already logged in to (uses your Claude subscription —
//      no API key, no credits). Auto-detected; override the binary with CLAUDE_BIN, model with CLAUDE_MODEL.
//   2. Ollama, a free local model (if running at OLLAMA_URL, default http://127.0.0.1:11434).
//   3. The built-in grounded analyst (deterministic, always available, works offline).
//
// CHAT_ENGINE=local|claude|ollama forces one. Every engine gets the same structured app context and
// the same no-invention rules; the local engine answers straight from that context.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { answerLocally, buildPrompt, systemPrompt } from '../public/chat-analyst.js';

const HOME = os.homedir();
const FORCE = (process.env.CHAT_ENGINE || '').toLowerCase();
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const TIMEOUT_MS = +(process.env.CHAT_TIMEOUT_SEC || 120) * 1000;

function findClaude() {
  if (process.env.CLAUDE_BIN) return fs.existsSync(process.env.CLAUDE_BIN) ? process.env.CLAUDE_BIN : null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(HOME, '.claude/local'), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.npm-global/bin'), path.join(HOME, '.bun/bin'));
  try { for (const v of fs.readdirSync(path.join(HOME, '.nvm/versions/node'))) dirs.push(path.join(HOME, '.nvm/versions/node', v, 'bin')); } catch { /* no nvm */ }
  for (const d of dirs) {
    const f = path.join(d, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* keep looking */ }
  }
  return null;
}

const status = { checkedAt: 0, claude: null, claudeError: null, claudeErrorAt: 0, ollama: null };

export async function engineStatus(force = false) {
  if (!force && Date.now() - status.checkedAt < 60e3) return publicStatus();
  status.checkedAt = Date.now();
  if (status.claudeError && Date.now() - status.claudeErrorAt > 120e3) status.claudeError = null; // retry after you log in
  status.claude = FORCE && FORCE !== 'claude' ? null : findClaude();
  status.ollama = null;
  if (!FORCE || FORCE === 'ollama') {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
      const j = await r.json();
      const models = (j.models || []).map((m) => m.name);
      const want = process.env.OLLAMA_MODEL;
      status.ollama = want ? (models.includes(want) || models.includes(want + ':latest') ? want : null) : models[0] || null;
    } catch { /* not running */ }
  }
  return publicStatus();
}

function publicStatus() {
  const claudeOk = status.claude && !status.claudeError;
  const active = FORCE === 'local' ? 'local' : claudeOk ? 'claude' : status.ollama ? 'ollama' : 'local';
  return {
    active,
    label: { claude: 'Claude · via your Claude Code login', ollama: `Local model · ${status.ollama}`, local: 'Built-in analyst · offline' }[active],
    claude: { found: !!status.claude, error: status.claudeError },
    ollama: status.ollama,
  };
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Make sure the CLI uses your subscription login, never a pay-as-you-go API key.
    if (process.env.CHAT_ALLOW_API_KEY !== '1') { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
    const args = ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', systemPrompt()];
    if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
    const child = spawn(status.claude, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude took too long to answer')); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && text) return resolve(text);
      const msg = (err || text || `exit ${code}`).trim().split('\n').slice(-3).join(' ');
      reject(Object.assign(new Error(msg), { auth: /log ?in|auth|credential|api key|subscription|\/login/i.test(msg) }));
    });
    child.stdin.on('error', () => { /* CLI exited before reading the prompt; 'close' reports why */ });
    child.stdin.end(prompt);
  });
}

async function runOllama(messages, ctx) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ model: status.ollama, stream: false, options: { temperature: 0.2 },
      messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: buildPrompt(messages, ctx) }] }),
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const j = await r.json();
  const text = j.message?.content?.trim();
  if (!text) throw new Error('Ollama returned no text');
  return text;
}

/** messages: [{role:'user'|'assistant', content}], ctx: buildContext() output. */
export async function chat(messages, ctx, { engine } = {}) {
  await engineStatus();
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const local = () => answerLocally(question, ctx);
  const want = engine === 'local' || FORCE === 'local' ? 'local' : publicStatus().active;
  if (want === 'claude') {
    try { return { engine: 'claude', label: publicStatus().label, text: await runClaude(buildPrompt(messages, ctx)) }; }
    catch (e) {
      if (e.auth) status.claudeErrorAt = Date.now(), status.claudeError = 'Claude Code is installed but not logged in. Run `claude` once in Terminal and sign in with your Claude account.';
      return { engine: 'local', label: 'Built-in analyst · offline', text: local(), notice: e.auth ? status.claudeError : `Claude didn't answer (${e.message.slice(0, 140)}), so the built-in analyst replied.` };
    }
  }
  if (want === 'ollama') {
    try { return { engine: 'ollama', label: publicStatus().label, text: await runOllama(messages, ctx) }; }
    catch (e) { return { engine: 'local', label: 'Built-in analyst · offline', text: local(), notice: `Local model didn't answer (${e.message}).` }; }
  }
  return { engine: 'local', label: 'Built-in analyst · offline', text: local() };
}
