import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanArgs, buildArgs, fillFromExample, shq, splitArgs, sampleFor } from '../tools/argscan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => readFileSync(join(ROOT, 'scripts', name), 'utf8');
const brief = (s) => s.positional.map((p) => [p.label, p.required, p.choices.join('|'), p.default]);

test('userctl.sh: usage labels, case choices, examples and prompts', () => {
  const s = scanArgs(script('userctl.sh'));
  assert.deepEqual(brief(s), [
    ['action', true, 'create|reset|delete', ''],
    ['username', true, '', ''],
    ['auth', false, 'pem|password|both', ''],
    ['sudo access', false, 'yes|no', ''],
    ['sftp access', false, 'yes|no', ''],
  ]);
  assert.deepEqual(s.examples, ['create admin both yes yes', 'create devuser pem no yes']);
  assert.equal(s.prompts.length, 3);
  assert.ok(s.env.some((e) => e.name === 'PEM_LINK_HOURS' && e.default === '24'));
  assert.ok(!s.env.some((e) => e.name === 'USER'));
});

test('share.sh: operand plus --flags from an option loop', () => {
  const s = scanArgs(script('share.sh'));
  assert.deepEqual(brief(s), [['file', true, '', '']]);
  const opts = Object.fromEntries(s.options.map((o) => [o.flag, o.takesValue]));
  assert.deepEqual(opts, { '--hours': true, '--name': true, '--no-passphrase': false });
  assert.equal(s.options.find((o) => o.flag === '--hours').sample, '24');
  assert.deepEqual(s.examples, ['~/.kube/config --hours 2']);
});

test('a script without arguments asks for none (function and awk $1 ignored)', () => {
  const s = scanArgs("#!/bin/bash\nfor f in /etc/*.conf; do echo \"$f\" | awk '{print $1}'; done\nlog() { echo \"$1\"; }\nlog hi\ncat <<'EOF' > /tmp/x.sh\nFILE=\"$1\"\nEOF\n");
  assert.equal(s.hasArgs, false);
});

test('defaults and env settings', () => {
  const s = scanArgs('#!/bin/bash\nHOST=${1:?host required}\nPORT="${2:-8080}"\nTIMEOUT=${TIMEOUT:-5}\nnc -z -w "$TIMEOUT" "$HOST" "$PORT"\n');
  assert.deepEqual(brief(s), [['host', true, '', ''], ['port', false, '', '8080']]);
  assert.deepEqual(s.env, [{ name: 'TIMEOUT', default: '5' }]);
  assert.equal(s.positional[0].sample, '10.0.0.5');
});

test('getopts with an inline usage function', () => {
  const s = scanArgs('#!/bin/bash\nusage(){ echo "usage: $0 [-n namespace] [-f] <deployment>"; exit 1; }\nwhile getopts ":n:fh" opt; do\n  case $opt in\n    n) NS=$OPTARG ;;\n    f) FORCE=1 ;;\n    h) usage ;;\n    *) usage ;;\n  esac\ndone\nshift $((OPTIND-1))\nDEP=$1\n');
  assert.equal(s.usage, '[-n namespace] [-f] <deployment>');
  assert.deepEqual(brief(s), [['deployment', true, '', '']]);
  assert.deepEqual(s.options.map((o) => [o.flag, o.takesValue]), [['-n', true], ['-f', false]]);
});

test('main "$@" forwards script arguments into a function', () => {
  const s = scanArgs('#!/bin/bash\nmain() {\n  local env="$1" region="${2:-us-east-1}"\n  case "$env" in\n    dev|development) echo d ;;\n    prod|production) echo p ;;\n  esac\n}\nmain "$@"\n');
  assert.deepEqual(brief(s), [['env', true, 'development|production', ''], ['region', false, '', 'us-east-1']]);
});

test('"$@" alone means free-form arguments', () => {
  const s = scanArgs('#!/bin/bash\nfor h in "$@"; do ping -c1 "$h"; done\n');
  assert.equal(s.positional.length, 1);
  assert.equal(s.positional[0].variadic, true);
});

test('buildArgs quotes values, fills gaps with empty strings and adds flags', () => {
  const s = scanArgs(script('userctl.sh'));
  assert.equal(buildArgs(s, { positional: ['create', 'jatin'] }), 'create jatin');
  assert.equal(buildArgs(s, { positional: ['create', 'jatin', '', 'yes'] }), "create jatin '' yes");
  assert.equal(buildArgs(s, { positional: ['create', "o'neil x"] }), `create 'o'\\''neil x'`);
  const sh = scanArgs(script('share.sh'));
  assert.equal(buildArgs(sh, { positional: ['./id.pem'], options: { '--hours': '2', '--no-passphrase': true } }), './id.pem --hours 2 --no-passphrase');
});

test('fillFromExample maps words back onto fields', () => {
  const sh = scanArgs(script('share.sh'));
  assert.deepEqual(fillFromExample(sh, '~/.kube/config --hours 2'), { positional: ['~/.kube/config'], options: { '--hours': '2' }, extra: '' });
  const u = scanArgs(script('userctl.sh'));
  assert.deepEqual(fillFromExample(u, 'create admin both yes yes').positional, ['create', 'admin', 'both', 'yes', 'yes']);
});

test('helpers', () => {
  assert.equal(shq('a b'), "'a b'");
  assert.equal(shq('~/x.pem'), '~/x.pem');
  assert.deepEqual(splitArgs(`a "b c" 'd e' f`), ['a', 'b c', 'd e', 'f']);
  assert.equal(sampleFor('region'), 'ap-south-1');
  assert.equal(sampleFor('x', ['one', 'two']), 'one');
});
