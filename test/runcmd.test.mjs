import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildRunCommand, withGuard, encodeShare, decodeShare, scriptName } from '../tools/runcmd.mjs';
import { LinkError } from '../tools/filelink.mjs';

const unix = process.platform !== 'win32';
const now = () => Math.floor(Date.now() / 1000);
const SCRIPT = '#!/bin/bash\r\nset -e\r\necho "name=$0 args=$*"\r\nread -r -p "answer: " a\r\necho "got=$a"\r\n';

/** Runs the command the way a person pastes it: as input to an interactive-ish shell. */
const paste = (command, stdin = '') => spawnSync('bash', ['-c', command], { input: stdin, encoding: 'utf8' });

test('scriptName', () => {
  assert.equal(scriptName('userctl.sh'), 'userctl');
  assert.equal(scriptName('my script!.bash'), 'my-script-');
  assert.equal(scriptName(''), 'script');
});

test('withGuard goes after the shebang, normalises CRLF and replaces an old guard', () => {
  const g = withGuard(SCRIPT, 2_000_000_000);
  assert.ok(!g.includes('\r'));
  const lines = g.split('\n');
  assert.equal(lines[0], '#!/bin/bash');
  assert.match(lines[1], /^# shellpin: expires 2033-05-18 03:33 UTC$/);
  assert.match(lines[2], /-lt 2000000000 \]/);
  const again = withGuard(g, 2_100_000_000);
  assert.equal(again.match(/# shellpin: expires/g).length, 1);
  assert.match(withGuard('echo hi', 2_000_000_000), /^# shellpin: expires .*\n.*\necho hi\n$/);
});

test('size limit', async () => {
  await assert.rejects(buildRunCommand({ text: `#!/bin/bash\n#${'x'.repeat(120_001)}`, expires: now() + 60 }), LinkError);
});

for (const oneLine of [false, true]) {
  test(`command runs with args, $0 and prompts (${oneLine ? 'one line' : 'multi-line'})`, { skip: !unix }, async () => {
    const { command } = await buildRunCommand({ text: SCRIPT, name: 'userctl.sh', args: 'create jatin', expires: now() + 3600, oneLine });
    const r = paste(command, 'yes\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /name=userctl args=create jatin/);
    assert.match(r.stdout, /got=yes/);
  });
}

test('expired command refuses to run', { skip: !unix }, async () => {
  const { command } = await buildRunCommand({ text: '#!/bin/bash\necho RAN\n', expires: now() - 5 });
  const r = paste(command);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /RAN/);
  assert.match(r.stderr, /expired/);
});

test('a damaged or cut-short paste runs nothing', { skip: !unix }, async () => {
  // Big enough to span several base64 lines.
  const text = `#!/bin/bash\necho RAN\n# ${randomBytes(3000).toString('hex')}\n`;
  const { command } = await buildRunCommand({ text, expires: now() + 3600 });
  const lines = command.split('\n');
  const cut = [...lines.slice(0, 3), ...lines.slice(4)].join('\n');
  const flipped = lines.map((l, i) => (i === 3 ? l.slice(0, 10) + (l[10] === 'A' ? 'B' : 'A') + l.slice(11) : l)).join('\n');
  for (const bad of [cut, flipped]) {
    const r = paste(bad);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /RAN/);
  }
});

test('share link round-trips the form', async () => {
  const s = { text: SCRIPT, name: 'userctl', args: 'create "a b"', sudo: true, expires: now() + 99 };
  const frag = await encodeShare(s);
  assert.match(frag, /^r1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(`#${frag}`), s);
  await assert.rejects(decodeShare('#r1.AAAA'), LinkError);
  await assert.rejects(decodeShare('#nope'), LinkError);
});
