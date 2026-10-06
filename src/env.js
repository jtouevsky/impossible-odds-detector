// Minimal .env loader (no dependencies). Import it first so every module sees the values.
// Real environment variables always win over the file. Secrets live only in .env, which git ignores.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
export const fromFile = new Set();

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

try {
  for (const [k, v] of Object.entries(parseEnv(fs.readFileSync(ENV_FILE, 'utf8'))))
    if (process.env[k] === undefined) { process.env[k] = v; fromFile.add(k); }
} catch { /* no .env file: defaults apply */ }

/** Create or update one KEY=value line in .env (used by the in-app "Save key" button). Empty value removes it. */
export function setEnvVar(key, value) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch { /* new file */ }
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  lines = lines.filter((l) => !re.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (value) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  if (value) { process.env[key] = value; fromFile.add(key); } else { delete process.env[key]; fromFile.delete(key); }
}
