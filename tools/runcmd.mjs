// "Paste a script, get a command": the script travels inside the command, so nothing is stored anywhere.
//
//   s="$(base64 -d <<'SHELLPIN' | gunzip
//   H4sI...            <- gzip + base64 of the script, 76 chars per line
//   SHELLPIN
//   )" && sudo bash -c "$s" userctl create jatin
//
// The script is decoded completely before anything runs: a damaged or partial paste makes gunzip fail
// (CRC/length check) and `&&` stops. `bash -c` keeps the terminal as stdin, so `read` prompts work.
// A prelude (fingerprint, expiry, host lock, secret prompts) is written into the script itself.
// Same idea for sh and `python3 -c`, kubectl/docker exec and ssh; PowerShell decodes into a [scriptblock].

import { gzip, gunzip, toB64url, fromB64url, LinkError } from './filelink.mjs';
import { shq } from './argscan.mjs';
import { compactPowerShell, compactPython, psInsertIndex, pyInsertIndex } from './langs.mjs';

export const MAX_SCRIPT_BYTES = 120_000; // `bash -c "$s"`: one argument is capped at 128 KiB on Linux
export const MAX_HOURS = 24 * 365;
const te = new TextEncoder();
const td = new TextDecoder();

const utc = (sec) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const scriptName = (name) => String(name || '').replace(/\.(sh|bash|ps1|psm1|py)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'script';

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

// ---------------------------------------------------------------------------------------------
// Prelude: added to the script itself, so it also applies on a remote host or in a container.
//   fingerprint and expiry comment, expiry check, host lock, secret prompts, (PowerShell) admin check

const BEGIN = '# >>> shellpin';
const END = '# <<< shellpin';
const PRELUDE_RE = /^# >>> shellpin.*\n[\s\S]*?^# <<< shellpin\n/m;
export const HOST_RE = /^[A-Za-z0-9._*?[\]-]+$/;
export const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shPrelude({ fp, expires, hosts, secrets }) {
  const sec = Math.floor(expires);
  const lines = [`${BEGIN} ${fp} · expires ${utc(sec)}`];
  lines.push(`[ "$(date +%s)" -lt ${sec} ] || { echo "shellpin: this command expired on ${utc(sec)}; get a new one" >&2; exit 1; }`);
  if (hosts.length) lines.push(`case "$(uname -n)" in ${hosts.join('|')}) ;; *) echo "shellpin: this command only runs on ${hosts.join(', ')}; this is $(uname -n)" >&2; exit 1 ;; esac`);
  for (const v of secrets) lines.push(`if [ -z "\${${v}:-}" ]; then printf '%s: ' '${v}' >&2; stty -echo 2>/dev/null; read -r ${v}; stty echo 2>/dev/null; echo >&2; fi; export ${v}`);
  lines.push(END);
  return lines.join('\n') + '\n';
}

function pyPrelude({ fp, expires, hosts, secrets, name }) {
  const sec = Math.floor(expires);
  const py = (s) => JSON.stringify(s);
  const mods = ['sys as _sp_sys', 'time as _sp_time'];
  if (hosts.length) mods.push('socket as _sp_socket', 'fnmatch as _sp_fnmatch');
  if (secrets.length) mods.push('os as _sp_os', 'getpass as _sp_getpass');
  const lines = [`${BEGIN} ${fp} · expires ${utc(sec)}`, `import ${mods.join(', ')}`, `_sp_sys.argv[0] = ${py(name)}`];
  lines.push(`if _sp_time.time() >= ${sec}: _sp_sys.exit(${py(`shellpin: this command expired on ${utc(sec)}; get a new one`)})`);
  if (hosts.length) lines.push(`if not any(_sp_fnmatch.fnmatch(_sp_socket.gethostname(), _p) for _p in ${py(hosts)}): _sp_sys.exit(${py(`shellpin: this command only runs on ${hosts.join(', ')}; this is `)} + _sp_socket.gethostname())`);
  for (const v of secrets) lines.push(`if not _sp_os.environ.get(${py(v)}): _sp_os.environ[${py(v)}] = _sp_getpass.getpass(${py(`${v}: `)})`);
  lines.push(END);
  return lines.join('\n') + '\n';
}

function psPrelude({ fp, expires, hosts, secrets, admin }) {
  const sec = Math.floor(expires);
  const lines = [`${BEGIN} ${fp} · expires ${utc(sec)}`];
  lines.push(`if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -ge ${sec}) { throw 'shellpin: this command expired on ${utc(sec)}; get a new one' }`);
  if (hosts.length) lines.push(`if (-not (@(${hosts.map((h) => `'${h}'`).join(', ')}) | Where-Object { [Environment]::MachineName -like $_ })) { throw ('shellpin: this command only runs on ${hosts.join(', ')}; this is ' + [Environment]::MachineName) }`);
  if (admin) lines.push(`if ($IsWindows -ne $false) { if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'shellpin: open PowerShell with "Run as administrator" and paste the command again' } } elseif ((id -u) -ne '0') { throw 'shellpin: run this in "sudo pwsh"' }`);
  for (const v of secrets) lines.push(`if (-not $env:${v}) { $env:${v} = [Net.NetworkCredential]::new('', (Read-Host '${v}' -AsSecureString)).Password }`);
  lines.push(END);
  return lines.join('\n') + '\n';
}

/** Inserts the prelude where each language allows code to run first. */
export function addPrelude(lang, text, opts) {
  let body = text.replace(/\r\n?/g, '\n').replace(PRELUDE_RE, '');
  if (!body.endsWith('\n')) body += '\n';
  if (lang === 'powershell') {
    const at = psInsertIndex(body);
    if (at < 0) throw new LinkError("Couldn't find where the script's param() block ends. Check its brackets and quotes.");
    const sep = at > 0 && body[at - 1] !== '\n' ? '\n' : '';
    return body.slice(0, at) + sep + psPrelude(opts) + body.slice(at).replace(/^[ \t]*\n/, '');
  }
  if (lang === 'python') {
    const at = Math.min(pyInsertIndex(body), body.length);
    return body.slice(0, at) + pyPrelude(opts) + body.slice(at);
  }
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n') + 1;
    return body.slice(0, nl) + shPrelude(opts) + body.slice(nl);
  }
  return shPrelude(opts) + body;
}

/** First 8 hex characters of the script's SHA-256 (after line-ending normalisation). */
export async function fingerprint(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(text.replace(/\r\n?/g, '\n'))));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const COMPACT = { bash: compactScript, sh: compactScript, python: compactPython, powershell: compactPowerShell };
const wrap = (data) => data.match(/.{1,76}/g).join('\n');
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const psLit = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Windows caps one environment variable at 32,767 characters; the payload travels in one.
export const PS_CHILD_LIMIT = 30_000;

/**
 * @param {object} o
 * @param {string} o.text
 * @param {'bash'|'sh'|'powershell'|'python'} [o.lang]
 * @param {{kind:'local'|'kubectl'|'docker'|'ssh', pod?:string, namespace?:string, container?:string, hosts?:string[]}} [o.target]
 * @returns {Promise<{command:string, preview:string, fingerprint:string, scriptBytes:number, notes:string[]}>}
 */
export async function buildRunCommand({
  text, lang = 'bash', name, args = '', sudo = false, expires, oneLine = false, env = [], secrets = [], compact = false,
  hosts = [], target = { kind: 'local' }, newProcess = true,
}) {
  const src = text.replace(/\r\n?/g, '\n');
  const fp = await fingerprint(src);
  const nm = scriptName(name);
  const lock = hosts.map((h) => String(h).trim()).filter(Boolean);
  const bad = lock.find((h) => !HOST_RE.test(h));
  if (bad) throw new LinkError(`Host pattern "${bad}" may only use letters, digits, . - _ and the wildcards * ? [ ].`);
  const asked = [...new Set(secrets.filter((v) => VAR_RE.test(v)))];
  const vars = env.filter(([k, v]) => VAR_RE.test(k) && v !== '' && !asked.includes(k));
  const body = compact ? (COMPACT[lang] || compactScript)(src) : src;
  const script = te.encode(addPrelude(lang, body, { fp, expires, hosts: lock, secrets: asked, name: nm, admin: lang === 'powershell' && sudo }));
  if (script.length > MAX_SCRIPT_BYTES) throw new LinkError(`The script is ${script.length} bytes; the limit is ${MAX_SCRIPT_BYTES}.`);
  const data = b64(await gzip(script));
  const a = args.trim() ? ` ${args.trim()}` : '';
  const notes = [];
  const base = { fingerprint: fp, scriptBytes: script.length, notes };

  if (lang === 'powershell') {
    if (target.kind && target.kind !== 'local') notes.push('PowerShell commands run in the window you paste them into; "Run on" applies to bash, sh and Python only.');
    const lit = oneLine ? `'${data}'` : `@'\n${wrap(data)}\n'@`;
    const decode = (from) => `[IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String(${from})),[IO.Compression.CompressionMode]::Decompress)).ReadToEnd()`;
    const envSet = vars.map(([k, v]) => `$env:${k}=${psLit(v)}; `).join('');
    const pre = `<# shellpin ${fp} #> `;
    const preview = `${pre}$s=${decode(lit)}; $s`;
    if (newProcess && data.length <= PS_CHILD_LIMIT) {
      // A child PowerShell: an `exit` in the script ends the child, not your window. Prompts still work.
      const inner = `$s=${decode('$env:SHELLPIN_S')}; Remove-Item Env:SHELLPIN_S; & ([scriptblock]::Create($s))${a}`;
      const command =
        `${pre}$env:SHELLPIN_S=${lit}; ${envSet}$c=${psLit(inner)}; ` +
        `& (Get-Process -Id $PID).Path -NoProfile -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($c))); ` +
        `Remove-Item Env:SHELLPIN_S -ErrorAction SilentlyContinue`;
      return { ...base, command, preview };
    }
    if (newProcess) notes.push('This script is too large to hand to a separate PowerShell process, so it runs in the current window. If it calls exit, the window closes.');
    return { ...base, command: `${pre}${envSet}$s=${decode(lit)}; & ([scriptblock]::Create($s))${a}`, preview };
  }

  const interp = lang === 'python' ? 'python3' : lang === 'sh' ? 'sh' : 'bash';
  const run = lang === 'python' ? `${interp} -c "$s"${a}` : `${interp} -c "$s" ${nm}${a}`;
  const envStr = vars.map(([k, v]) => `${k}=${shq(v)} `).join('');
  const pre = `: shellpin-${fp}; `;
  const decode = oneLine ? `s="$(echo ${data} | base64 -d | gunzip)"` : `s="$(base64 -d <<'SHELLPIN' | gunzip\n${wrap(data)}\nSHELLPIN\n)"`;
  const preview = `${pre}${decode} && printf '%s\\n' "$s"`;
  const kind = target.kind || 'local';

  if (kind === 'kubectl') {
    const pod = String(target.pod || '').trim();
    if (!/^[a-z0-9]([a-z0-9./-]*[a-z0-9])?$/.test(pod)) throw new LinkError('Enter the pod name (or deploy/name) to run in.');
    const ns = String(target.namespace || '').trim();
    const c = String(target.container || '').trim();
    if (ns && !/^[a-z0-9-]+$/.test(ns)) throw new LinkError('Namespace may only use lowercase letters, digits and -.');
    if (c && !/^[a-z0-9-]+$/.test(c)) throw new LinkError('Container name may only use lowercase letters, digits and -.');
    if (sudo) notes.push('sudo is ignored in a pod: the script runs as the container user.');
    const command = `${pre}${decode} && kubectl exec -it ${pod}${ns ? ` -n ${ns}` : ''}${c ? ` -c ${c}` : ''} -- ${vars.length ? `env ${envStr}` : ''}${run}`;
    notes.push('The script is decoded on your machine and passed to the pod, so the container needs only the interpreter, not base64 or gunzip.');
    return { ...base, command, preview };
  }
  if (kind === 'docker') {
    const c = String(target.container || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c)) throw new LinkError('Enter the container name or ID to run in.');
    const command = `${pre}${decode} && docker exec -it${sudo ? ' -u root' : ''} ${c} ${vars.length ? `env ${envStr}` : ''}${run}`;
    return { ...base, command, preview };
  }
  if (kind === 'ssh') {
    const list = (target.hosts || []).map((h) => String(h).trim()).filter(Boolean);
    if (!list.length) throw new LinkError('Enter at least one SSH host (host, user@host or an alias from ~/.ssh/config).');
    const badHost = list.find((h) => !/^[A-Za-z0-9._@:-]+$/.test(h));
    if (badHost) throw new LinkError(`"${badHost}" doesn't look like an SSH host.`);
    const remote = sq(`s="$(echo ${data} | base64 -d | gunzip)" && ${sudo ? 'sudo ' : ''}${envStr}${run}`);
    const command = list.length === 1
      ? `${pre}ssh -t ${list[0]} ${remote}`
      : `${pre}for h in ${list.join(' ')}; do echo "== $h"; ssh -t "$h" ${remote}; done`;
    return { ...base, command, preview };
  }
  return { ...base, command: `${pre}${decode} && ${sudo ? 'sudo ' : ''}${envStr}${run}`, preview };
}

// ---- share link: the whole form in the URL fragment, so a colleague can open the same command ----

export async function encodeShare(state) {
  const json = JSON.stringify({
    v: 1, n: state.name || '', a: state.args || '', s: !!state.sudo, e: Math.floor(state.expires), t: state.text,
    f: state.fields || null, c: state.compact !== false, o: state.opts || null,
  });
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
  const obj = (x) => (x && typeof x === 'object' ? x : null);
  return { name: String(o.n), args: String(o.a), sudo: !!o.s, expires: o.e, text: o.t, fields: obj(o.f), compact: o.c !== false, opts: obj(o.o) };
}
