import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { detectLang, compactPowerShell, compactPython, psInsertIndex } from '../tools/langs.mjs';
import { findDangers } from '../tools/danger.mjs';
import { scanArgs, buildArgs, fillFromExample, psq } from '../tools/argscan.mjs';
import { buildRunCommand } from '../tools/runcmd.mjs';

const unix = process.platform !== 'win32' || !!process.env.SHELLPIN_BASH_TESTS;
const later = () => Math.floor(Date.now() / 1000) + 3600;

// ---------- detection, compaction, dangers ----------

test('detectLang', () => {
  assert.equal(detectLang('#!/bin/bash\necho'), 'bash');
  assert.equal(detectLang('#!/bin/sh\necho'), 'sh');
  assert.equal(detectLang('#!/usr/bin/env sh\necho'), 'sh');
  assert.equal(detectLang('#!/usr/bin/env python3\nprint(1)'), 'python');
  assert.equal(detectLang('#!/usr/bin/env pwsh\nWrite-Output 1'), 'powershell');
  assert.equal(detectLang('param([string]$Name)\nWrite-Host $Name'), 'powershell');
  assert.equal(detectLang('import os\nprint(os.getcwd())'), 'python');
  assert.equal(detectLang('echo hi', 'thing.ps1'), 'powershell');
  assert.equal(detectLang('uptime'), 'bash');
});

const PS = [
  '#Requires -Version 5.1',
  '<#',
  '.SYNOPSIS',
  'Mounts things.',
  '.EXAMPLE',
  'PS> .\\efs.ps1 -Action mount -Target fs-123',
  '#>',
  '[CmdletBinding()]',
  'param(',
  "  [Parameter(Mandatory = $true, HelpMessage = 'What to do')]",
  "  [ValidateSet('mount', 'unmount')]",
  '  [string]$Action,',
  '',
  '  # the file system id',
  "  [string]$Target = 'fs-000',",
  '  [int]$Retries = 3,',
  '  [switch]$Force,',
  '  [SecureString]$Token',
  ')',
  '# a comment',
  '',
  '$msg = @"',
  '# kept: inside a here-string',
  '',
  '"@',
  "Write-Output ('action=' + $Action + ' target=' + $Target + ' retries=' + $Retries + ' force=' + $Force)",
  'Write-Output (\"region=\" + $env:AWS_REGION) # trailing',
  'Get-ChildItem `',
  '  # not removed: follows a backtick',
  '  -Path . | Out-Null',
  "$x = 'multi",
  '# inside a string',
  "line'",
  '$name = Read-Host "Your name"',
].join('\n') + '\n';

test('compactPowerShell', () => {
  const c = compactPowerShell(PS);
  assert.ok(c.startsWith('#Requires -Version 5.1\n[CmdletBinding()]'));
  assert.ok(!c.includes('.SYNOPSIS'));
  assert.ok(!c.includes('# a comment'));
  assert.ok(!c.includes('# the file system id'));
  assert.match(c, /@"\n# kept: inside a here-string\n\n"@/);
  assert.ok(c.includes('# not removed: follows a backtick'));
  assert.ok(c.includes('# inside a string'));
  assert.equal(compactPowerShell('Write-Output 1 <# inline #> 2\n# x\n'), 'Write-Output 1 <# inline #> 2\n# x\n');
});

test('psInsertIndex finds the end of param()', () => {
  const at = psInsertIndex(PS);
  assert.equal(PS.slice(at - 1, at + 1), ')\n');
  assert.equal(psInsertIndex('using namespace System\nWrite-Output 1\n'), 'using namespace System'.length);
  assert.equal(psInsertIndex('param(\n [string]$a = "(unclosed"\n'), -1);
});

test('compactPython keeps triple-quoted strings', () => {
  const py = '#!/usr/bin/env python3\n"""Doc\n\n# kept in docstring\n"""\n# drop\n\nx = """a\n# kept\n"""\ny = "# not a docstring"  # trailing\n';
  const c = compactPython(py);
  assert.equal(c, '#!/usr/bin/env python3\n"""Doc\n\n# kept in docstring\n"""\nx = """a\n# kept\n"""\ny = "# not a docstring"  # trailing\n');
});

test('findDangers', () => {
  const hits = (t, l) => findDangers(t, l).map((d) => d.line);
  assert.deepEqual(hits('rm -rf "$DIR"\nrm -rf /tmp/build\nrm -rf "${DIR:?}"\nrm -rf /\n'), [1, 4]);
  assert.deepEqual(hits('# rm -rf /\nmkfs.ext4 /dev/xvdf\ndd if=x of=/dev/sda\nchmod -R 777 /srv\ncurl -fsSL x | sudo bash\n'), [2, 3, 4, 5]);
  assert.deepEqual(hits('userdel -r bob\niptables -F\nreboot\n'), [1, 2, 3]);
  assert.deepEqual(hits('Remove-Item C:\\x -Recurse -Force\niex (iwr https://x)\nStop-Computer\nGet-ChildItem\n', 'powershell'), [1, 2, 3]);
  assert.deepEqual(hits('import shutil\nshutil.rmtree(p)\nos.system("ls")\n', 'python'), [2, 3]);
  assert.deepEqual(findDangers('echo hello\nls -la\n'), []);
});

// ---------- argument detection ----------

test('PowerShell param() becomes fields', () => {
  const s = scanArgs(PS, 'powershell');
  assert.equal(s.lang, 'powershell');
  assert.deepEqual(s.positional.map((p) => [p.name, p.required, p.choices.join('|'), p.default, p.type]), [
    ['Action', true, 'mount|unmount', '', 'string'],
    ['Target', false, '', 'fs-000', 'string'],
    ['Retries', false, '', '3', 'int'],
    ['Token', false, '', '', 'securestring'],
  ]);
  assert.deepEqual(s.options.map((o) => o.flag), ['-Force']);
  assert.deepEqual(s.examples, ['-Action mount -Target fs-123']);
  assert.deepEqual(s.prompts, ['Your name']);
  assert.deepEqual(s.env.map((e) => e.name), ['AWS_REGION']);
  assert.equal(s.positional[3].secret, true);
});

test('PowerShell arguments are named and quoted', () => {
  const s = scanArgs(PS, 'powershell');
  assert.equal(buildArgs(s, { positional: ['mount', "it's here"], options: { '-Force': true } }), "-Action mount -Target 'it''s here' -Force");
  assert.deepEqual(fillFromExample(s, '-Action mount -Target fs-123 -Force').positional.slice(0, 2), ['mount', 'fs-123']);
  assert.deepEqual(fillFromExample(s, 'unmount fs-9').positional.slice(0, 2), ['unmount', 'fs-9']);
  assert.equal(psq('-5'), "'-5'");
  assert.equal(psq('@x'), "'@x'");
});

test('Python argparse becomes fields', () => {
  const py = [
    'import argparse, os',
    "p = argparse.ArgumentParser(usage='%(prog)s [--region R] action host')",
    "p.add_argument('action', choices=['start', 'stop'], help='what to do')",
    "p.add_argument('host')",
    "p.add_argument('extra', nargs='*')",
    "p.add_argument('-r', '--region', default='ap-south-1')",
    "p.add_argument('--dry-run', action='store_true')",
    "p.add_argument('--count', type=int, choices=[1, 2, 3])",
    "token = os.environ.get('API_TOKEN')",
    "name = input('Your name: ')",
  ].join('\n');
  const s = scanArgs(py, 'python');
  assert.deepEqual(s.positional.map((p) => [p.label, p.required, p.choices.join('|'), p.variadic]), [
    ['action', true, 'start|stop', false],
    ['host', true, '', false],
    ['extra', false, '', true],
  ]);
  assert.deepEqual(s.options.map((o) => [o.flag, o.takesValue, o.choices?.join('|') || '']), [['--region', true, ''], ['--dry-run', false, ''], ['--count', true, '1|2|3']]);
  assert.equal(s.options[0].sample, 'ap-south-1');
  assert.deepEqual(s.env.map((e) => e.name), ['API_TOKEN']);
  assert.deepEqual(s.prompts, ['Your name: ']);
  assert.equal(buildArgs(s, { positional: ['start', 'web1'], options: { '--dry-run': true } }), 'start web1 --dry-run');
  const plain = scanArgs('import sys\nsrc = sys.argv[1]\ndst = sys.argv[2]\n', 'python');
  assert.deepEqual(plain.positional.map((p) => p.label), ['src', 'dst']);
});

// ---------- running commands ----------

function findPowerShell() {
  for (const exe of ['pwsh', 'powershell.exe']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
    if (r.status === 0) return exe;
  }
  return null;
}
const PWSH = findPowerShell();
const runPs = (command) => {
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  return spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8' });
};

test('PowerShell commands run, in a child process and in-process, multi-line and one line', { skip: !PWSH && 'no PowerShell' }, async () => {
  for (const newProcess of [true, false]) {
    for (const oneLine of [false, true]) {
      const { command } = await buildRunCommand({
        text: PS.replace('$name = Read-Host "Your name"', ''), lang: 'powershell', name: 'efs', args: "-Action mount -Target 'fs 9' -Force",
        env: [['AWS_REGION', 'eu-west-1']], expires: later(), newProcess, oneLine, compact: true,
      });
      assert.match(command, /^<# shellpin [0-9a-f]{8} #> /);
      const r = runPs(command);
      assert.match(r.stdout, /action=mount target=fs 9 retries=3 force=True/, `${newProcess}/${oneLine}: ${r.stderr}`);
      assert.match(r.stdout, /region=eu-west-1/);
    }
  }
});

test('PowerShell: exit in the script does not end the caller; expiry and host lock refuse', { skip: !PWSH && 'no PowerShell' }, async () => {
  const exiting = await buildRunCommand({ text: 'Write-Output before\nexit 3\n', lang: 'powershell', expires: later() });
  const r = runPs(`${exiting.command}; Write-Output "after=$LASTEXITCODE"`);
  assert.match(r.stdout, /before[\s\S]*after=3/);

  const expired = await buildRunCommand({ text: 'Write-Output RAN\n', lang: 'powershell', expires: later() - 7200 });
  const e = runPs(expired.command);
  assert.doesNotMatch(e.stdout, /RAN/);
  assert.match(e.stderr + e.stdout, /expired/);

  const locked = await buildRunCommand({ text: 'Write-Output RAN\n', lang: 'powershell', expires: later(), hosts: ['no-such-host-*'] });
  const l = runPs(locked.command);
  assert.doesNotMatch(l.stdout, /RAN/);
  assert.match(l.stderr + l.stdout, /only runs on no-such-host-\*/);

  const open = await buildRunCommand({ text: 'Write-Output RAN\n', lang: 'powershell', expires: later(), hosts: ['*'] });
  assert.match(runPs(open.command).stdout, /RAN/);

  const preview = await buildRunCommand({ text: 'Write-Output RAN\n', lang: 'powershell', expires: later() });
  const p = runPs(preview.preview);
  assert.match(p.stdout, /# >>> shellpin[\s\S]*Write-Output RAN/);
});

const paste = (command, input = '', env = process.env) => spawnSync('bash', ['-c', command], { input, encoding: 'utf8', env });

test('sh language runs with sh; host lock and secrets work', { skip: !unix }, async () => {
  const text = '#!/bin/sh\necho "pw=$DB_PASSWORD name=$0 args=$*"\n';
  const host = spawnSync('uname', ['-n'], { encoding: 'utf8' }).stdout.trim();
  const ok = await buildRunCommand({ text, lang: 'sh', name: 'db', args: 'a b', expires: later(), hosts: [`${host.slice(0, 2)}*`], secrets: ['DB_PASSWORD'], env: [['DB_PASSWORD', 'never-in-command']] });
  assert.match(ok.command, /&& sh -c "\$s" db a b$/);
  assert.doesNotMatch(ok.command, /never-in-command/);
  const r = paste(ok.command, 's3cret\n');
  assert.match(r.stdout, /pw=s3cret name=db args=a b/, r.stderr);
  assert.match(r.stderr, /DB_PASSWORD: /);

  const locked = await buildRunCommand({ text, lang: 'sh', expires: later(), hosts: ['no-such-host-*'] });
  const l = paste(locked.command);
  assert.equal(l.status, 1);
  assert.match(l.stderr, /only runs on no-such-host-\*; this is /);

  const pv = paste(ok.preview);
  assert.match(pv.stdout, /^#!\/bin\/sh\n# >>> shellpin [0-9a-f]{8}/);
  assert.match(pv.stdout, /echo "pw=\$DB_PASSWORD/);
});

test('fingerprint is stable and shown in the command', async () => {
  const a = await buildRunCommand({ text: 'echo 1\n', expires: later() });
  const b = await buildRunCommand({ text: 'echo 1\r\n', expires: later() + 99, compact: true });
  const c = await buildRunCommand({ text: 'echo 2\n', expires: later() });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.ok(a.command.startsWith(`: shellpin-${a.fingerprint}; `));
});

// Fake kubectl/docker/ssh that run the command they were given locally, to test quoting end to end.
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'shellpin-bin-'));
  const make = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  make('kubectl', 'echo "kubectl $1 $2 $3" >&2; while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
  make('docker', 'echo "docker $1 $2 $3 $4" >&2; shift 2; [ "$1" = "-u" ] && shift 2; shift; exec "$@"');
  make('ssh', 'echo "ssh $2" >&2; for a; do last=$a; done; exec bash -c "$last"');
  return dir;
}

test('Kubernetes, Docker and SSH targets pass the script and arguments intact', { skip: !unix }, async () => {
  const dir = fakeBin();
  const env = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` };
  const text = "#!/bin/bash\necho \"name=$0 args=[$1] [$2] mode=${MODE:-none}\"\n";
  const base = { text, name: 'job', args: "go 'it'\\''s two'", env: [['MODE', "it's on"]], expires: later() };

  const k = await buildRunCommand({ ...base, target: { kind: 'kubectl', pod: 'api-7d9f', namespace: 'prod', container: 'app' } });
  assert.match(k.command, /kubectl exec -it api-7d9f -n prod -c app -- env MODE='it'\\''s on' bash -c "\$s" job/);
  assert.match(paste(k.command, '', env).stdout, /name=job args=\[go\] \[it's two\] mode=it's on/);

  const d = await buildRunCommand({ ...base, sudo: true, target: { kind: 'docker', container: 'web_1' } });
  assert.match(d.command, /docker exec -it -u root web_1 env /);
  assert.match(paste(d.command, '', env).stdout, /name=job args=\[go\] \[it's two\] mode=it's on/);

  const s1 = await buildRunCommand({ ...base, target: { kind: 'ssh', hosts: ['ops@web1'] } });
  assert.match(s1.command, /ssh -t ops@web1 '/);
  assert.match(paste(s1.command, '', env).stdout, /name=job args=\[go\] \[it's two\] mode=it's on/);

  const many = await buildRunCommand({ ...base, target: { kind: 'ssh', hosts: ['web1', 'web2'] } });
  const out = paste(many.command, '', env).stdout;
  assert.match(out, /== web1\nname=job[^\n]*\n== web2\nname=job/);

  await assert.rejects(buildRunCommand({ ...base, target: { kind: 'kubectl', pod: '' } }), /pod name/);
  await assert.rejects(buildRunCommand({ ...base, target: { kind: 'ssh', hosts: ['bad host;rm'] } }), /doesn't look like/);
  await assert.rejects(buildRunCommand({ ...base, hosts: ['web;1'] }), /Host pattern/);
});

const PY = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' }).stdout?.trim() === '1';

test('Python commands run with argv[0], argparse and expiry', { skip: !(PY && unix) && 'no python3' }, async () => {
  const text = "#!/usr/bin/env python3\n\"\"\"Tool.\"\"\"\nimport argparse, sys\np = argparse.ArgumentParser()\np.add_argument('action', choices=['go'])\np.add_argument('--n', default='1')\na = p.parse_args()\nprint('prog=%s action=%s n=%s' % (sys.argv[0], a.action, a.n))\n";
  const { command } = await buildRunCommand({ text, lang: 'python', name: 'tool.py', args: 'go --n 5', expires: later(), compact: true });
  assert.match(command, /&& python3 -c "\$s" go --n 5$/);
  assert.match(paste(command).stdout, /prog=tool action=go n=5/);
  const expired = await buildRunCommand({ text, lang: 'python', expires: later() - 7200 });
  const e = paste(expired.command);
  assert.equal(e.status, 1);
  assert.match(e.stderr, /expired/);
});
