#!/usr/bin/env node
// Usage: node tools/build.mjs [--check] [--prune] [--today=YYYY-MM-DD] [--src=scripts] [--out=dist]
//   (default) validate, then write the Pages site to --out, leaving out expired scripts
//   --check   validate only
//   --prune   delete expired scripts from --src (run by the daily job, which commits the result)
import { readdir, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScript, isoDay, isValidDay, shellPayload, MAX_DAYS, MAX_BYTES } from './rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export async function loadScripts(src, today) {
  const files = (await readdir(src)).filter((f) => f.endsWith('.sh')).sort();
  const out = [];
  for (const file of files) {
    const text = await readFile(join(src, file), 'utf8');
    out.push({ file, name: file.slice(0, -3), text, ...checkScript(file.slice(0, -3), text, today) });
  }
  const other = (await readdir(src)).filter((f) => !f.endsWith('.sh') && !f.startsWith('.') && f !== 'README.md');
  return { scripts: out, other };
}

export async function build({ src, out, today, repo = '', branch = 'main' }) {
  const { scripts } = await loadScripts(src, today);
  const live = scripts.filter((s) => !s.errors.length && !s.expired);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 's'), { recursive: true });

  const index = [];
  for (const s of live) {
    const bytes = Buffer.from(s.text, 'utf8');
    const fileSha = sha256(bytes);
    await writeFile(join(out, 's', s.file), bytes);
    await writeFile(join(out, 's', `${s.file}.sha256`), `${fileSha}  ${s.file}\n`);
    index.push({
      name: s.name,
      description: s.meta.description || '',
      usage: s.meta.usage || '',
      expires: s.meta.expires,
      bytes: bytes.length,
      lines: s.text.split('\n').length,
      sha256: fileSha,
      shellSha256: sha256(Buffer.from(shellPayload(s.text), 'utf8')),
    });
  }
  const manifest = { generated: today, repo, branch, maxDays: MAX_DAYS, maxBytes: MAX_BYTES, scripts: index };
  await writeFile(join(out, 'scripts.json'), JSON.stringify(manifest, null, 2) + '\n');

  for (const f of await readdir(join(ROOT, 'site'))) await copyFile(join(ROOT, 'site', f), join(out, f));
  await copyFile(join(ROOT, 'tools', 'rules.mjs'), join(out, 'rules.js'));
  await copyFile(join(ROOT, 'tools', 'filelink.mjs'), join(out, 'filelink.js'));
  const runcmd = await readFile(join(ROOT, 'tools', 'runcmd.mjs'), 'utf8');
  await copyFile(join(ROOT, 'tools', 'argscan.mjs'), join(out, 'argscan.js'));
  await writeFile(join(out, 'runcmd.js'), runcmd.replaceAll("'./filelink.mjs'", "'./filelink.js'").replaceAll("'./argscan.mjs'", "'./argscan.js'"));
  await writeFile(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  return manifest;
}

async function main(argv) {
  const opt = Object.fromEntries(argv.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const today = opt.today || isoDay(new Date());
  if (!isValidDay(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`);
  const src = join(ROOT, opt.src || 'scripts');
  const { scripts, other } = await loadScripts(src, today);

  let failed = false;
  for (const f of other) console.log(`::warning file=scripts/${f}::Only *.sh files are published; ${f} is ignored.`);
  for (const s of scripts) {
    for (const e of s.errors) {
      console.log(`::error file=scripts/${s.file}::${e}`);
      failed = true;
    }
    if (s.expired) console.log(`::notice file=scripts/${s.file}::Expired on ${s.meta.expires}; not published.`);
    else if (!s.errors.length) console.log(`ok  ${s.file}  expires ${s.meta.expires} (${s.daysLeft} days)`);
  }
  if (failed) process.exit(1);

  if (opt.prune) {
    for (const s of scripts.filter((x) => x.expired)) {
      await rm(join(src, s.file));
      console.log(`pruned ${s.file}`);
    }
    return;
  }
  if (opt.check) return;

  const m = await build({ src, out: join(ROOT, opt.out || 'dist'), today, repo: process.env.GITHUB_REPOSITORY || '', branch: process.env.SHELLPIN_BRANCH || 'main' });
  console.log(`built ${m.scripts.length} script(s) into ${opt.out || 'dist'}/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
