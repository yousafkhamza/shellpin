import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createLink, parseLink, openLink, toB64url, fromB64url, safeName, LinkError, MAX_FILE_BYTES } from '../tools/filelink.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://example.github.io/shellpin/f.html';
const later = () => Date.now() / 1000 + 3600;
const unix = process.platform !== 'win32' || !!process.env.SHELLPIN_BASH_TESTS;

test('base64url round-trips every length', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(randomBytes(n));
    assert.deepEqual(fromB64url(toB64url(b)), b);
  }
  assert.throws(() => fromB64url('ab+c'), LinkError);
});

test('safeName strips paths and odd characters', () => {
  assert.equal(safeName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeName('my key.pem'), 'my_key.pem');
  assert.equal(safeName(''), 'file');
});

test('plain link round-trips binary content', async () => {
  const bytes = new Uint8Array(randomBytes(5000));
  const url = await createLink(PAGE, { name: 'blob.bin', bytes, expires: later() });
  assert.match(url, /^https:\/\/example\.github\.io\/shellpin\/f\.html#f1\.z\.[A-Za-z0-9_-]+$/);
  const f = await openLink(parseLink(url));
  assert.equal(f.name, 'blob.bin');
  assert.deepEqual(f.bytes, bytes);
});

test('encrypted link needs the right passphrase', async () => {
  const bytes = new TextEncoder().encode('-----BEGIN TEST KEY-----\nabc\n');
  const url = await createLink(PAGE, { name: 'jatin.pem', bytes, expires: later(), passphrase: 'correct horse' });
  const parsed = parseLink(url);
  assert.equal(parsed.encrypted, true);
  assert.deepEqual((await openLink(parsed, 'correct horse')).bytes, bytes);
  await assert.rejects(openLink(parsed, 'wrong'), LinkError);
});

test('parseLink tolerates chat-app line breaks and rejects junk', () => {
  const p = parseLink('https://x/f.html#f1.z.abc\n  def');
  assert.equal(p.data, 'abcdef');
  assert.throws(() => parseLink('https://x/f.html#hello'), LinkError);
  assert.throws(() => parseLink('f1.q.abc'), LinkError);
});

test('a cut-short link fails with a clear error', async () => {
  const url = await createLink(PAGE, { name: 'a.txt', bytes: new Uint8Array(randomBytes(2000)), expires: later() });
  await assert.rejects(openLink(parseLink(url.slice(0, -400))), LinkError);
});

test('size limit', async () => {
  await assert.rejects(createLink(PAGE, { name: 'big', bytes: new Uint8Array(MAX_FILE_BYTES + 1), expires: later() }), LinkError);
});

// ---- interoperability with the bash side (real openssl, gzip, base64) ----

async function runShare(args, env = {}) {
  const out = execFileSync('bash', [join(ROOT, 'scripts', 'share.sh'), ...args], {
    env: { ...process.env, SHELLPIN_URL: 'https://example.github.io/shellpin', ...env },
    encoding: 'utf8',
  });
  const url = /https:\/\/\S+#f1\.[zp]\.[A-Za-z0-9_-]+/.exec(out)?.[0];
  const pass = /^Passphrase: (\S+)$/m.exec(out)?.[1];
  return { out, url, pass };
}

test('share.sh links open in the page code (with passphrase)', { skip: !unix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-'));
  const bytes = randomBytes(3000);
  await writeFile(join(dir, 'jatin.pem'), bytes);
  const { url, pass } = await runShare([join(dir, 'jatin.pem'), '--hours', '2'], { SHELLPIN_PASSPHRASE: 'from-test-123' });
  assert.equal(pass, 'from-test-123');
  assert.match(url, /^https:\/\/example\.github\.io\/shellpin\/f\.html#f1\.p\./);
  const f = await openLink(parseLink(url), pass);
  assert.equal(f.name, 'jatin.pem');
  assert.deepEqual(Buffer.from(f.bytes), bytes);
  const hours = (f.expires - Date.now() / 1000) / 3600;
  assert.ok(hours > 1.9 && hours <= 2.01, `expiry ~2h, got ${hours}`);
});

test('share.sh generates a passphrase by default and supports --no-passphrase', { skip: !unix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-'));
  await writeFile(join(dir, 'kube config'), 'apiVersion: v1\n');
  const a = await runShare([join(dir, 'kube config')]);
  assert.match(a.pass, /^[0-9a-f]{24}$/);
  assert.equal((await openLink(parseLink(a.url), a.pass)).name, 'kube_config');
  const b = await runShare([join(dir, 'kube config'), '--no-passphrase', '--name', 'config']);
  assert.equal(b.pass, undefined);
  const f = await openLink(parseLink(b.url));
  assert.equal(new TextDecoder().decode(f.bytes), 'apiVersion: v1\n');
});

test('page-made encrypted links decrypt with openssl', { skip: !unix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-'));
  const url = await createLink(PAGE, { name: 'x.txt', bytes: new TextEncoder().encode('hello from the browser\n'), expires: later(), passphrase: 'pw-123456' });
  await writeFile(join(dir, 'blob'), Buffer.from(fromB64url(parseLink(url).data)));
  const out = execFileSync('bash', ['-c', 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 -md sha256 -pass pass:pw-123456 -in "$1" | gunzip', 'x', join(dir, 'blob')], { encoding: 'utf8' });
  assert.match(out, /^shellpin-file 1\nname: x\.txt\nexpires: \d+\n\nhello from the browser\n$/);
});

test("userctl.sh's PEM link uses the same format", { skip: !unix }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-'));
  const src = await readFile(join(ROOT, 'scripts', 'userctl.sh'), 'utf8');
  const fn = /^SHELLPIN_URL=.*?^}\n/ms.exec(src)?.[0];
  assert.ok(fn, 'upload_pem block not found');
  await writeFile(join(dir, 'fn.sh'), fn);
  await writeFile(join(dir, 'k'), 'KEY\n');
  const out = execFileSync('bash', ['-c', 'source "$1"; upload_pem', 'x', join(dir, 'fn.sh')], {
    env: { ...process.env, USER: 'jatin', KEY_FILE: join(dir, 'k'), SHELLPIN_URL: 'https://example.github.io/shellpin' },
    encoding: 'utf8',
  });
  const url = /https:\/\/\S+#f1\.[zp]\.[A-Za-z0-9_-]+/.exec(out)[0];
  const pass = /^Passphrase: (\S+)$/m.exec(out)?.[1] ?? '';
  const f = await openLink(parseLink(url), pass);
  assert.equal(f.name, 'jatin.pem');
  assert.equal(new TextDecoder().decode(f.bytes), 'KEY\n');
});
