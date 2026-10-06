// In-app analyst chat: floating button + panel. Sends the question together with a structured,
// data-only snapshot of what the app is showing (selected trade, prices, books, fees, payoff table,
// match checks, rules, bucket, filters, board metrics). The server picks the AI engine.
import { buildContext, SUGGESTIONS, BOARD_SUGGESTIONS, CROWD_SUGGESTIONS, CROWD_BOARD_SUGGESTIONS } from '/chat-analyst.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const C = { open: false, pinned: null, pinnedResearch: false, messages: [], busy: false, ctxKey: null, engine: null };

document.body.insertAdjacentHTML('beforeend', `
  <button class="chat-fab" id="chat-fab" aria-label="Open analyst chat" aria-expanded="false">
    <svg viewBox="0 0 24 24" class="ico"><path d="M12 3.5l1.6 4.2 4.4 1.6-4.4 1.6L12 15.1l-1.6-4.2L6 9.3l4.4-1.6z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>
    <span>Ask</span>
  </button>
  <section class="chat-panel glass" id="chat-panel" role="dialog" aria-label="Analyst chat" hidden>
    <header class="chat-h">
      <div class="chat-t"><b>Analyst</b><span class="chat-engine" id="chat-engine"><i></i><span>Connecting…</span></span></div>
      <button class="chat-x" id="chat-clear" title="New conversation" aria-label="New conversation"><svg viewBox="0 0 24 24" class="ico"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg></button>
      <button class="chat-x" id="chat-close" aria-label="Close chat"><svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </header>
    <div class="chat-ctx" id="chat-ctx"></div>
    <div class="chat-log" id="chat-log" aria-live="polite"></div>
    <div class="chat-sugg" id="chat-sugg"></div>
    <form class="chat-in" id="chat-form">
      <textarea id="chat-q" rows="1" placeholder="Ask about this trade, a number, or a term…" aria-label="Your question"></textarea>
      <button class="chat-send" id="chat-send" aria-label="Send"><svg viewBox="0 0 24 24" class="ico"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    </form>
    <div class="chat-foot">Answers use only the data on screen · not financial advice</div>
  </section>`);

// ---------------------------------------------------------------- context
function snapshot() {
  const a = window.IOD?.snapshot?.() || { S: {}, visible: [] };
  const S = a.S || {};
  const research = window.IOD_RESEARCH?.() || null;
  const onResearch = S.view === 'research';
  const onCrowd = S.view === 'crowd';
  const crowd = window.IOD_CROWD?.() || null;
  const opp = !onResearch && !onCrowd && C.pinned ? S.data?.opportunities?.find((o) => o.id === C.pinned) : null;
  const ctx = buildContext({ view: S.view, mode: a.mode, filters: S.filters, data: S.data, visible: a.visible, opportunity: opp,
    research: onResearch ? research : { count: research?.count ?? null }, scannedAt: S.scannedAt, crowd: onCrowd ? crowd : crowd ? { count: crowd.count, feed: crowd.feed } : null });
  if (onCrowd) {
    const sel = crowd?.selected;
    return { ctx, label: sel ? `${sel.event.title} · ${sel.target.venueName}` : 'Crowd disagreement board', kind: sel ? 'crowd' : 'crowd-board', key: sel ? 'c:' + sel.id : 'crowd' };
  }
  const label = opp ? opp.title : onResearch && research?.selected ? `Research · ${research.selected.title}` : S.data ? `${{ arb: 'Guaranteed', near: 'Near-arb', research: 'Research', providers: 'Venues' }[S.view] || 'Board'} board` : 'Loading market data';
  const kind = opp ? opp.bucket : onResearch && research?.selected ? 'research' : 'board';
  return { ctx, label, kind, key: opp ? 'o:' + opp.id : onResearch && research?.selected ? 'r:' + research.selected.title : 'board' };
}

function renderCtx() {
  const s = snapshot();
  const tag = { guaranteed: '<span class="pill verified">GUARANTEED</span>', near: '<span class="pill near">NEAR-ARB</span>', research: '<span class="pill likely">RESEARCH</span>', crowd: '<span class="pill research">CROWD</span>', board: '' }[s.kind] || '';
  $('chat-ctx').innerHTML = `<span class="chat-ctx-k">Analyzing</span><span class="chat-ctx-v" title="${esc(s.label)}">${esc(s.label)}</span>${tag}${C.pinned && s.kind !== 'research' && s.kind !== 'board' ? '<button class="chat-unpin" id="chat-unpin" title="Talk about the whole board instead" aria-label="Unpin">×</button>' : ''}`;
  const u = $('chat-unpin'); if (u) u.onclick = () => { C.pinned = null; renderCtx(); renderSugg(); };
  renderSugg(s);
  return s;
}

function renderSugg(s = snapshot()) {
  const list = s.kind === 'crowd' ? CROWD_SUGGESTIONS : s.kind === 'crowd-board' ? CROWD_BOARD_SUGGESTIONS : s.kind === 'board' ? BOARD_SUGGESTIONS : s.kind === 'research'
    ? ['Explain this anomaly simply', 'Is this a trade I can make money on?', 'What does violation size mean?', 'Why is this only research?']
    : s.kind === 'guaranteed' ? SUGGESTIONS.filter((x) => !/isn't/.test(x)) : SUGGESTIONS.filter((x) => !/considered arbitrage/.test(x));
  const show = !C.busy && (C.messages.length === 0 || C.ctxKey !== s.key);
  $('chat-sugg').classList.toggle('compact', !show);
  $('chat-sugg').innerHTML = (show ? list : list.filter((q) => !C.messages.some((m) => m.content === q)).slice(0, 4)).map((q) => `<button type="button">${esc(q)}</button>`).join('');
}

// ---------------------------------------------------------------- rendering
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/^#{1,6}\s+/, '');
    const ul = line.match(/^\s*[-•*]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const t = ul ? 'ul' : 'ol';
      if (!list || list.t !== t) { if (list) out.push(`</${list.t}>`); out.push(`<${t}>`); list = { t }; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.t}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.t}>`);
  return out.join('');
}

function add(role, content, meta = {}) {
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = `msg ${role}${meta.pending ? ' pending' : ''}`;
  el.innerHTML = meta.pending ? '<span class="dots"><i></i><i></i><i></i></span>' : role === 'user' ? `<p>${esc(content)}</p>` : md(content);
  if (meta.note) el.insertAdjacentHTML('beforeend', `<div class="msg-note">${esc(meta.note)}</div>`);
  log.appendChild(el);
  // Long answers: show their beginning, not their end.
  log.scrollTop = role === 'assistant' && !meta.pending ? Math.max(0, el.offsetTop - 8) : log.scrollHeight;
  return el;
}

function divider(label) {
  $('chat-log').insertAdjacentHTML('beforeend', `<div class="msg-div"><span>Now analyzing · ${esc(label)}</span></div>`);
}

function setEngine(st) {
  C.engine = st;
  const e = $('chat-engine');
  e.className = `chat-engine ${st?.active || ''}`;
  e.querySelector('span').textContent = st?.label || 'Built-in analyst · offline';
  e.title = st?.active === 'claude' ? 'Answers come from Claude through the Claude Code app you are logged in to on this Mac — your Claude subscription, no API credits.'
    : st?.active === 'ollama' ? 'Answers come from a free model running locally in Ollama.'
      : (st?.claude?.error || 'No AI model detected, so a built-in analyst answers from the app\'s own data. Install and log in to Claude Code to get Claude answers.');
}

// ---------------------------------------------------------------- send
async function ask(question) {
  question = question.trim();
  if (!question || C.busy) return;
  const s = snapshot();
  if (C.messages.length && C.ctxKey !== s.key) divider(s.label);
  C.ctxKey = s.key;
  C.messages.push({ role: 'user', content: question });
  add('user', question);
  $('chat-q').value = ''; autosize();
  C.busy = true; $('chat-send').disabled = true; renderSugg(s);
  $('chat-sugg').hidden = true;
  const pending = add('assistant', '', { pending: true });
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: C.messages, context: s.ctx }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    pending.remove();
    C.messages.push({ role: 'assistant', content: j.text });
    add('assistant', j.text, { note: j.notice || (C.engine && j.engine !== C.engine.active ? j.label : '') });
    if (j.notice) fetch('/api/chat/status').then((x) => x.json()).then(setEngine).catch(() => {});
  } catch (err) {
    pending.remove();
    C.messages.pop();
    add('assistant', `I couldn't reach the app server (${err.message}). Is it still running?`);
  } finally {
    C.busy = false; $('chat-send').disabled = false;
    renderSugg(); $('chat-sugg').hidden = false;
  }
}

// ---------------------------------------------------------------- open / close
function toggle(on = !C.open) {
  C.open = on;
  $('chat-panel').hidden = !on;
  $('chat-fab').classList.toggle('on', on);
  $('chat-fab').setAttribute('aria-expanded', String(on));
  if (on) { renderCtx(); requestAnimationFrame(() => { $('chat-panel').classList.add('in'); $('chat-q').focus(); }); }
  else $('chat-panel').classList.remove('in');
}

function autosize() { const t = $('chat-q'); t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight) + 'px'; }

$('chat-fab').onclick = () => toggle();
$('chat-close').onclick = () => toggle(false);
$('chat-clear').onclick = () => { C.messages = []; C.ctxKey = null; $('chat-log').innerHTML = ''; renderCtx(); };
$('chat-form').onsubmit = (e) => { e.preventDefault(); ask($('chat-q').value); };
$('chat-q').addEventListener('input', autosize);
$('chat-q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('chat-q').value); } });
$('chat-sugg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
$('chat-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggle(false); $('chat-fab').focus(); } });

// Follow what the user is looking at.
window.addEventListener('iod:focus', (e) => { C.pinned = e.detail.id; if (C.open) renderCtx(); });
window.addEventListener('iod:ask', (e) => {
  C.pinned = e.detail.id; toggle(true);
  const s = snapshot();
  if (C.ctxKey !== s.key) ask('Explain this opportunity simply');
});
window.addEventListener('iod:crowd-focus', () => { if (C.open) setTimeout(renderCtx, 0); });
window.addEventListener('iod:ask-crowd', () => {
  toggle(true);
  const s = snapshot();
  if (C.ctxKey !== s.key) ask('Explain this comparison simply');
});
window.addEventListener('iod:data', () => { if (C.open) setTimeout(renderCtx, 0); });
document.getElementById('tabs')?.addEventListener('click', () => setTimeout(() => { if (C.open) renderCtx(); }, 0));
document.addEventListener('click', (e) => { if (C.open && e.target.closest('#rows tr, #drawer, .opp, #scrim, #cclose, #aclose')) setTimeout(renderCtx, 0); });

fetch('/api/chat/status').then((r) => r.json()).then(setEngine).catch(() => setEngine(null));
