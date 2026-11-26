// File links: a whole file packed into the URL fragment (#...), which browsers never send to a server.
// Format:  <page>#f1.<mode>.<base64url>
//   mode z: gzip(packed)
//   mode p: openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -md sha256 -salt  over gzip(packed)
//           ("Salted__" + 8-byte salt + ciphertext; key||iv = PBKDF2-SHA256(pass, salt, 48 bytes))
// packed:  "shellpin-file 1\nname: <name>\nexpires: <unix seconds>\n\n" + file bytes
// Shared by the browser page and the tests; scripts/share.sh and scripts/userctl.sh write the same format.

export const PBKDF2_ITER = 250_000;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_HOURS = 24 * 365;
const MAGIC = 'shellpin-file 1';
const SALTED = 'Salted__';
const te = new TextEncoder();
const td = new TextDecoder();

export class LinkError extends Error {}

export function toB64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new LinkError('The link is damaged: it has characters a shellpin link never has.');
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw new LinkError('The link is damaged or cut short.');
  }
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

async function through(bytes, transform) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(transform)).arrayBuffer());
}
export const gzip = (b) => through(b, new CompressionStream('gzip'));
export const gunzip = (b) => through(b, new DecompressionStream('gzip'));

async function keyIv(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, base, 384));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-CBC', false, ['encrypt', 'decrypt']);
  return { key, iv: bits.slice(32) };
}

/** Same bytes as `openssl enc -aes-256-cbc -pbkdf2 -iter 250000 -md sha256 -salt`. */
export async function opensslEncrypt(bytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv } = await keyIv(passphrase, salt);
  return concat(te.encode(SALTED), salt, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, bytes)));
}

export async function opensslDecrypt(bytes, passphrase) {
  if (bytes.length < 32 || td.decode(bytes.slice(0, 8)) !== SALTED) throw new LinkError('The link is damaged: the encrypted data is incomplete.');
  const { key, iv } = await keyIv(passphrase, bytes.slice(8, 16));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, bytes.slice(16)));
  } catch {
    throw new LinkError('Wrong passphrase.');
  }
}

export const safeName = (name) => String(name || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'file';

export function pack({ name, expires, bytes }) {
  return concat(te.encode(`${MAGIC}\nname: ${safeName(name)}\nexpires: ${Math.floor(expires)}\n\n`), bytes);
}

export function unpack(all) {
  let cut = -1;
  for (let i = 0; i < Math.min(all.length - 1, 512); i++) if (all[i] === 10 && all[i + 1] === 10) { cut = i; break; }
  const lines = cut < 0 ? [] : td.decode(all.slice(0, cut)).split('\n');
  if (lines[0] !== MAGIC) throw new LinkError('This is not a shellpin file link, or it was made by a newer version.');
  const head = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  const expires = Number(head.expires);
  if (!Number.isFinite(expires)) throw new LinkError('The link is damaged: no valid expiry.');
  return { name: safeName(head.name), expires, bytes: all.slice(cut + 2) };
}

/** Accepts a full URL or just the fragment, tolerating whitespace and line breaks added by chat apps. */
export function parseLink(input) {
  const s = String(input).replace(/\s+/g, '');
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
  const m = /^f1\.([zp])\.([A-Za-z0-9_-]+)$/.exec(frag);
  if (!m) throw new LinkError('That does not look like a shellpin file link (it should contain #f1.).');
  return { encrypted: m[1] === 'p', data: m[2] };
}

export async function openLink({ encrypted, data }, passphrase = '') {
  let bytes = fromB64url(data);
  if (encrypted) bytes = await opensslDecrypt(bytes, passphrase);
  try {
    bytes = await gunzip(bytes);
  } catch {
    throw new LinkError(encrypted ? 'Wrong passphrase, or the link is damaged.' : 'The link is damaged or cut short.');
  }
  return unpack(bytes);
}

export async function createLink(pageUrl, { name, bytes, expires, passphrase = '' }) {
  if (bytes.length > MAX_FILE_BYTES) throw new LinkError(`Files over ${MAX_FILE_BYTES / 1024} KB make links too long to share.`);
  let out = await gzip(pack({ name, expires, bytes }));
  if (passphrase) out = await opensslEncrypt(out, passphrase);
  return `${pageUrl.split('#')[0]}#f1.${passphrase ? 'p' : 'z'}.${toB64url(out)}`;
}

/** 96 random bits as 24 hex characters: easy to read out, same shape as `openssl rand -hex 12`. */
export function newPassphrase() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}
