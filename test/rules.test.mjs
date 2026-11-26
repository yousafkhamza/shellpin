import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkScript, parseMeta, applyMeta, shellPayload, addDays, daysBetween, isValidDay } from '../tools/rules.mjs';
import { build } from '../tools/build.mjs';

const TODAY = '2026-11-26';
const ok = (expires = '2026-12-26', body = 'echo hi\n') => `#!/bin/bash\n# @description Says hi\n# @expires ${expires}\n${body}`;

test('dates', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-11-26', '2027-11-26'), 365);
  assert.ok(isValidDay('2028-02-29'));
  assert.ok(!isValidDay('2027-02-29'));
  assert.ok(!isValidDay('2027-1-01'));
});

test('parseMeta reads the first value of each known tag', () => {
  const m = parseMeta('#!/bin/bash\n# @description  A  thing \n#@expires 2027-01-01\n# @expires 2099-01-01\n# @owner me\n');
  assert.deepEqual(m, { description: 'A  thing', expires: '2027-01-01' });
});

test('a valid script passes', () => {
  const r = checkScript('hello', ok(), TODAY);
  assert.deepEqual(r.errors, []);
  assert.equal(r.daysLeft, 30);
  assert.equal(r.expired, false);
});

test('expiry is capped at 365 days', () => {
  assert.deepEqual(checkScript('a', ok('2027-11-26'), TODAY).errors, []);
  assert.match(checkScript('a', ok('2027-11-27'), TODAY).errors.join(), /limit is 365/);
});

test('expired on its expiry day, without an error', () => {
  const r = checkScript('a', ok(TODAY), TODAY);
  assert.equal(r.expired, true);
  assert.deepEqual(r.errors, []);
});

test('rejects missing or bad expiry, CRLF, missing shebang, bad names', () => {
  assert.match(checkScript('a', '#!/bin/bash\necho\n', TODAY).errors.join(), /Missing/);
  assert.match(checkScript('a', ok('2027-02-30'), TODAY).errors.join(), /not a valid/);
  assert.match(checkScript('a', ok().replace(/\n/g, '\r\n'), TODAY).errors.join(), /CRLF/);
  assert.match(checkScript('a', ok().slice(12), TODAY).errors.join(), /shebang/);
  assert.match(checkScript('Bad_Name', ok(), TODAY).errors.join(), /lowercase/);
  assert.match(checkScript('a', ok(undefined, 'x'.repeat(120_001)), TODAY).errors.join(), /limit is 120000/);
});

test('rejects credentials', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n';
  assert.match(checkScript('a', ok(undefined, key), TODAY).errors.join(), /private key/);
  assert.match(checkScript('a', ok(undefined, 'K=AKIAABCDEFGHIJKLMNOP\n'), TODAY).errors.join(), /AWS access key/);
  assert.match(checkScript('a', ok(undefined, `T=ghp_${'a'.repeat(36)}\n`), TODAY).errors.join(), /GitHub token/);
  // Mentioning key words is fine; only literal keys are refused.
  assert.deepEqual(checkScript('a', ok(undefined, 'ssh-keygen -t rsa -f "$KEY_FILE"\n'), TODAY).errors, []);
});

test('applyMeta writes tags after the shebang and replaces old ones', () => {
  const out = applyMeta('#!/bin/sh\r\n# @expires 2020-01-01\r\necho hi\r\n', { description: 'Hi', expires: '2027-01-01' });
  assert.equal(out, '#!/bin/sh\n# @description Hi\n# @expires 2027-01-01\necho hi\n');
  assert.equal(applyMeta('echo hi', { expires: '2027-01-01' }), '#!/bin/bash\n# @expires 2027-01-01\necho hi');
});

test('shellPayload matches bash command substitution', () => {
  assert.equal(shellPayload('a\n\nb\n\n\n'), 'a\n\nb');
});

test('build writes live scripts, checksums and a manifest, and skips expired ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-'));
  const src = join(dir, 'scripts');
  await mkdir(src);
  await writeFile(join(src, 'live.sh'), ok());
  await writeFile(join(src, 'old.sh'), ok('2026-11-01'));
  const out = join(dir, 'dist');
  const m = await build({ src, out, today: TODAY, repo: 'me/shellpin' });

  assert.deepEqual(m.scripts.map((s) => s.name), ['live']);
  const body = await readFile(join(out, 's', 'live.sh'), 'utf8');
  assert.equal(body, ok());
  const sum = createHash('sha256').update(body).digest('hex');
  assert.equal(await readFile(join(out, 's', 'live.sh.sha256'), 'utf8'), `${sum}  live.sh\n`);
  assert.equal(m.scripts[0].shellSha256, createHash('sha256').update(shellPayload(body)).digest('hex'));
  await assert.rejects(readFile(join(out, 's', 'old.sh')));
  for (const f of ['index.html', 'app.js', 'style.css', 'rules.js', 'scripts.json', 'f.html', 'share.js', 'filelink.js', 'scripts.html', 'run.js', 'runcmd.js']) await readFile(join(out, f));
  assert.match(await readFile(join(out, 'runcmd.js'), 'utf8'), /from './filelink.js'/);
});
