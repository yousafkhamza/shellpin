// "Paste a script, get a command": the script travels inside the command, so nothing is stored anywhere.
//
//   s="$(base64 -d <<'SHELLPIN' | gunzip
//   H4sI...            <- gzip + base64 of the script, 76 chars per line
//   SHELLPIN
//   )" && sudo bash -c "$s" userctl create jatin
//
// The script is decoded completely before anything runs: a damaged or partial paste makes gunzip fail
// (CRC/length check) and `&&` stops. `bash -c` keeps the terminal as stdin, so `read` prompts work.
// An expiry guard is added at the top of the script; after that time the command refuses to run.

import { gzip, gunzip, toB64url, fromB64url, LinkError } from './filelink.mjs';
import { shq } from './argscan.mjs';

export const MAX_SCRIPT_BYTES = 120_000; // `bash -c "$s"`: one argument is capped at 128 KiB on Linux
export const MAX_HOURS = 24 * 365;
const te = new TextEncoder();
const td = new TextDecoder();
const GUARD_RE = /^# shellpin: expires .*\n\[ "\$\(date \+%s\)" -lt \d+ \] \|\| \{ .* \}\n/m;

const utc = (sec) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const scriptName = (name) => String(name || '').replace(/\.(sh|bash)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'script';

/**
 * Removes full-line comments and blank lines where bash itself ignores them, to shorten the command.
 * Kept: the shebang, heredoc bodies, lines inside multi-line quoted strings, and any line that follows a
 * backslash continuation. If the quote/heredoc tracking ends in an unexpected state, the original is returned.
 */
export function compactScript(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let quote = ''; // '' | "'" | '"' : open quote carried over from previous lines
  const heredocs = []; // pending terminators, in order
  let continued = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (heredocs.length) {
      out.push(line);
      const { word, tabs } = heredocs[0];
      if ((tabs ? line.replace(/^\t+/, '') : line) === word) heredocs.shift();
      continue;
    }
    const droppable = i > 0 && !quote && !continued && (/^\s*$/.test(line) || /^\s*#/.test(line));
    if (droppable) continue;
    out.push(line);

    // Scan the line to carry quote state forward and spot heredocs and continuations.
    let j = 0;
    let prev = ' ';
    while (j < line.length) {
      const c = line[j];
      if (quote === "'") {
        if (c === "'") quote = '';
      } else if (quote === '"') {
        if (c === '\\') j++;
        else if (c === '"') quote = '';
      } else if (c === '\\') {
        j++;
      } else if (c === "'" || c === '"') {
        quote = prev === '$' && c === "'" ? "'" : c;
      } else if (c === '#' && /[\s;|&()]/.test(prev)) {
        break; // trailing comment
      } else if (c === '<' && line[j + 1] === '<' && line[j + 2] !== '<' && prev !== '<') {
        const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(j));
        if (m) {
          heredocs.push({ word: m[3], tabs: m[1] === '-' });
          j += m[0].length;
          prev = 'x';
          continue;
        }
      }
      prev = c;
      j++;
    }
    continued = !quote && /(^|[^\\])(\\\\)*\\$/.test(line);
  }
  if (quote || heredocs.length) return text.replace(/\r\n?/g, '\n');
  return out.join('\n') + '\n';
}

/** Normalises line endings and adds (or replaces) the expiry guard right after the shebang. */
export function withGuard(text, expires) {
  const sec = Math.floor(expires);
  const guard =
    `# shellpin: expires ${utc(sec)}\n` +
    `[ "$(date +%s)" -lt ${sec} ] || { echo "shellpin: this command expired on ${utc(sec)}; get a new one" >&2; exit 1; }\n`;
  let body = text.replace(/\r\n?/g, '\n').replace(GUARD_RE, '');
  if (!body.endsWith('\n')) body += '\n';
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n') + 1;
    return body.slice(0, nl) + guard + body.slice(nl);
  }
  return guard + body;
}

/**
 * @param {{ text: string, name?: string, args?: string, sudo?: boolean, expires: number, oneLine?: boolean }} o
 * @returns {Promise<{ command: string, scriptBytes: number }>}
 */
export async function buildRunCommand({ text, name, args = '', sudo = false, expires, oneLine = false, env = [], compact = false }) {
  const script = te.encode(withGuard(compact ? compactScript(text) : text, expires));
  if (script.length > MAX_SCRIPT_BYTES) throw new LinkError(`The script is ${script.length} bytes; the limit is ${MAX_SCRIPT_BYTES}.`);
  const data = b64(await gzip(script));
  // Settings go after sudo (sudo resets the environment), as VAR=value bash -c ...
  const vars = env.filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== '').map(([k, v]) => `${k}=${shq(v)} `).join('');
  const run = `${sudo ? 'sudo ' : ''}${vars}bash -c "$s" ${scriptName(name)}${args.trim() ? ` ${args.trim()}` : ''}`;
  const command = oneLine
    ? `s="$(echo ${data} | base64 -d | gunzip)" && ${run}`
    : `s="$(base64 -d <<'SHELLPIN' | gunzip\n${data.match(/.{1,76}/g).join('\n')}\nSHELLPIN\n)" && ${run}`;
  return { command, scriptBytes: script.length };
}

// ---- share link: the whole form in the URL fragment, so a colleague can open the same command ----

export async function encodeShare(state) {
  const json = JSON.stringify({ v: 1, n: state.name || '', a: state.args || '', s: !!state.sudo, e: Math.floor(state.expires), t: state.text, f: state.fields || null, c: state.compact !== false });
  return `r1.${toB64url(await gzip(te.encode(json)))}`;
}

export async function decodeShare(fragment) {
  const m = /^#?r1\.([A-Za-z0-9_-]+)$/.exec(String(fragment).replace(/\s+/g, ''));
  if (!m) throw new LinkError('That is not a shellpin run link.');
  let o;
  try {
    o = JSON.parse(td.decode(await gunzip(fromB64url(m[1]))));
  } catch {
    throw new LinkError('The link is damaged or cut short.');
  }
  if (o?.v !== 1 || typeof o.t !== 'string' || !Number.isFinite(o.e)) throw new LinkError('The link is damaged or from a newer version.');
  return { name: String(o.n), args: String(o.a), sudo: !!o.s, expires: o.e, text: o.t, fields: o.f && typeof o.f === "object" ? o.f : null, compact: o.c !== false };
}
