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
export async function buildRunCommand({ text, name, args = '', sudo = false, expires, oneLine = false }) {
  const script = te.encode(withGuard(text, expires));
  if (script.length > MAX_SCRIPT_BYTES) throw new LinkError(`The script is ${script.length} bytes; the limit is ${MAX_SCRIPT_BYTES}.`);
  const data = b64(await gzip(script));
  const run = `${sudo ? 'sudo ' : ''}bash -c "$s" ${scriptName(name)}${args.trim() ? ` ${args.trim()}` : ''}`;
  const command = oneLine
    ? `s="$(echo ${data} | base64 -d | gunzip)" && ${run}`
    : `s="$(base64 -d <<'SHELLPIN' | gunzip\n${data.match(/.{1,76}/g).join('\n')}\nSHELLPIN\n)" && ${run}`;
  return { command, scriptBytes: script.length };
}

// ---- share link: the whole form in the URL fragment, so a colleague can open the same command ----

export async function encodeShare(state) {
  const json = JSON.stringify({ v: 1, n: state.name || '', a: state.args || '', s: !!state.sudo, e: Math.floor(state.expires), t: state.text });
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
  return { name: String(o.n), args: String(o.a), sudo: !!o.s, expires: o.e, text: o.t };
}
