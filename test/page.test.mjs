// Drives site/run.js (as built) against a tiny fake DOM made from the ids in site/index.html.
// Not a browser: it checks the page logic end to end (paste → fields → command → share link → reopen).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from '../tools/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USERCTL = readFileSync(join(ROOT, 'scripts', 'userctl.sh'), 'utf8');

// ---------- fake DOM ----------
let registry;
class Text {
  constructor(s) { this.textContent = String(s); }
}
class El {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], options: [], _text: '', hidden: false, value: '', checked: false, className: '', listeners: {}, attrs: {}, open: false });
    this.classList = { add() {}, remove() {} };
  }
  set id(v) { this._id = v; registry.set(v, this); }
  get id() { return this._id; }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new Text(n) : n;
      this.children.push(node);
      if (this.tagName === 'SELECT' && node.tagName === 'OPTION') this.options.push(node);
    }
  }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...n) { this.children = []; this.options = []; this.append(...n); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get childElementCount() { return this.children.length; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} }); }
  click() { this.fire('click'); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {} select() {} remove() {} scrollIntoView() {}
}

function freshDom(hash = '') {
  registry = new Map();
  const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
  for (const m of html.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const el = new El(m[1]);
    el.id = m[3];
    const attrs = m[2] + m[4];
    el.hidden = /\shidden\b/.test(attrs);
    el.checked = /\schecked\b/.test(attrs);
  }
  // <select id="hours"> options, with the selected one as value.
  const sel = /<select id="hours">([\s\S]*?)<\/select>/.exec(html)[1];
  for (const o of sel.matchAll(/<option value="(\d+)"( selected)?>([^<]*)<\/option>/g)) {
    const opt = new El('option');
    Object.assign(opt, { value: o[1] });
    opt.textContent = o[3];
    registry.get('hours').append(opt);
    if (o[2]) registry.get('hours').value = o[1];
  }
  const clip = { text: '' };
  globalThis.document = { getElementById: (id) => registry.get(id) ?? null, createElement: (t) => new El(t), body: new El('body'), execCommand() {} };
  globalThis.Option = function Option(text, value) { const o = new El('option'); o.textContent = text; o.value = value; return o; };
  globalThis.location = { href: `https://example.github.io/shellpin/${hash}`, hash, pathname: '/shellpin/', search: '' };
  globalThis.history = { replaceState() {} };
  globalThis.matchMedia = () => ({ matches: false });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { clip.text = t; } } }, configurable: true });
  return { $: (id) => registry.get(id), clip };
}

let dist;
let n = 0;
async function loadPage(hash = '') {
  const dom = freshDom(hash);
  await import(`${pathToFileURL(process.env.SHELLPIN_PAGE_ENTRY || join(dist, 'run.js')).href}?v=${++n}`);
  return dom;
}
async function type($, id, value, event = 'input') {
  $(id).value = value;
  $(id).fire(event);
  await sleep(350); // debounce + async render
}

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shellpin-page-'));
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'scripts', 'x.sh'), '#!/bin/bash\n# @expires 2099-01-01\necho\n');
  dist = join(dir, 'dist');
  await build({ src: join(dir, 'scripts'), out: dist, today: '2098-12-01' });
});

test('userctl.sh: fields appear, example fills them, command and env update', async () => {
  const { $ } = await loadPage();
  assert.equal($('argpanel').hidden, true);
  await type($, 't', USERCTL);
  await type($, 'name', 'userctl');

  assert.equal($('argpanel').hidden, false);
  assert.equal($('noargs').hidden, true);
  assert.deepEqual($('pos-1').options.map((o) => o.value), ['', 'create', 'reset', 'delete']);
  assert.equal($('pos-2').tagName, 'INPUT');
  assert.match($('pos-2').placeholder, /^e\.g\. /);
  assert.equal($('env-box').hidden, false);
  assert.ok($('env-PEM_LINK_HOURS'));
  assert.equal($('arg-sample').textContent, 'create admin both yes yes');
  assert.equal($('arg-prompts').hidden, false);
  assert.match($('issues').textContent, /Required by the script: action, username/);

  // Click the second documented example.
  const chips = $('arg-examples').children.filter((c) => c.tagName === 'BUTTON');
  assert.deepEqual(chips.map((c) => c.textContent), ['create admin both yes yes', 'create devuser pem no yes']);
  chips[1].click();
  await sleep(100);
  assert.equal($('pos-2').value, 'devuser');
  assert.match($('cmd').textContent, /\)" && bash -c "\$s" userctl create devuser pem no yes$/);

  // Edit fields by hand: leave $3 empty but fill $4, so $3 becomes ''.
  await type($, 'pos-2', 'jatin');
  await type($, 'pos-3', '');
  await type($, 'pos-5', '');
  await type($, 'pos-4', 'yes');
  assert.match($('cmd').textContent, /userctl create jatin '' yes$/);
  assert.doesNotMatch($('issues').textContent, /Required/);

  await type($, 'env-PEM_LINK_HOURS', '2');
  $('sudo').checked = true;
  $('sudo').fire('change');
  await sleep(100);
  assert.match($('cmd').textContent, /&& sudo PEM_LINK_HOURS=2 bash -c "\$s" userctl create jatin '' yes$/);
  assert.equal($('out').hidden, false);
});

test('share link reopens with the same fields', async () => {
  const first = await loadPage();
  await type(first.$, 't', USERCTL);
  await type(first.$, 'name', 'userctl');
  await type(first.$, 'pos-1', 'delete');
  await type(first.$, 'pos-2', 'olduser');
  first.$('copy-link').click();
  await sleep(150);
  const url = first.clip.text;
  assert.match(url, /^https:\/\/example\.github\.io\/shellpin\/#r1\./);

  const second = await loadPage(url.slice(url.indexOf('#')));
  await sleep(300);
  assert.equal(second.$('pos-1').value, 'delete');
  assert.equal(second.$('pos-2').value, 'olduser');
  assert.match(second.$('cmd').textContent, /bash -c "\$s" userctl delete olduser$/);
});

test('a script without arguments shows no argument fields until asked', async () => {
  const { $ } = await loadPage();
  await type($, 't', '#!/bin/bash\nset -e\nuptime\ndf -h\n');
  assert.equal($('argpanel').hidden, true);
  assert.equal($('noargs').hidden, false);
  assert.match($('cmd').textContent, /\)" && bash -c "\$s" script$/);
  $('add-args').click();
  await sleep(50);
  assert.equal($('argpanel').hidden, false);
  await type($, 'extra', '--verbose now');
  assert.match($('cmd').textContent, /script --verbose now$/);
});

test('options: share.sh style flags become inputs and checkboxes', async () => {
  const { $ } = await loadPage();
  await type($, 't', readFileSync(join(ROOT, 'scripts', 'share.sh'), 'utf8'));
  assert.equal($('opt-0').type, 'text');
  assert.equal($('opt-2').type, 'checkbox');
  await type($, 'pos-1', './jatin.pem');
  await type($, 'opt-0', '2');
  $('opt-2').checked = true;
  $('opt-2').fire('change');
  await sleep(100);
  assert.match($('cmd').textContent, /bash -c "\$s" script \.\/jatin\.pem --hours 2 --no-passphrase$/);
});

test('compact is on by default and shortens the command', async () => {
  const { $ } = await loadPage();
  assert.equal($('compact').checked, true);
  await type($, 't', USERCTL);
  const short = $('cmd').textContent;
  assert.match($('size').textContent, /compact saved/);
  $('compact').checked = false;
  $('compact').fire('change');
  await sleep(150);
  assert.ok($('cmd').textContent.length > short.length + 800, `${$('cmd').textContent.length} vs ${short.length}`);
});
