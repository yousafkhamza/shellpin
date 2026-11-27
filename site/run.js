import { buildRunCommand, encodeShare, decodeShare, scriptName, MAX_SCRIPT_BYTES, MAX_HOURS } from './runcmd.js';
import { scanArgs, buildArgs, fillFromExample } from './argscan.js';
import { detectLang, LANGS } from './langs.js';
import { findDangers } from './danger.js';
import { findSecrets } from './rules.js';

const $ = (id) => document.getElementById(id);
function appendAll(node, kids) {
  for (const k of kids.flat()) if (k != null && k !== false) node.append(k);
  return node;
}
const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
const LONG_LINK = 8000;
const SECRET_NAME = /PASS|SECRET|TOKEN|KEY|PWD|CREDENTIAL|AUTH/i;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtWhen = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const splitList = (s) => String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

// Expiry is fixed when the script or duration changes, not on every keystroke in the argument fields,
// so the command doesn't change under you while you copy it.
let expires = 0;
let seq = 0;
let timer;
let fileName = '';

// What the script takes, and what the person filled in. Values survive re-scans (keyed by position/flag/name).
let scan = scanArgs('');
let scanKey = '';
let forceArgs = false;
const values = { positional: [], options: {}, env: {}, ask: {}, extra: '' };

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(what);
}

function resetExpiry() {
  expires = Math.floor(Date.now() / 1000) + Math.min(Number($('hours').value), MAX_HOURS) * 3600;
}

const detected = () => detectLang($('t').value, fileName);
const lang = () => ($('lang').value === 'auto' ? detected() : $('lang').value);
const argString = () => buildArgs(scan, values);
const askList = () => scan.env.filter((e) => values.ask[e.name]).map((e) => e.name);
const envList = () => scan.env.filter((e) => !values.ask[e.name]).map((e) => [e.name, values.env[e.name] ?? '']);
const target = () => {
  const kind = $('target').value;
  if (kind === 'kubectl') return { kind, pod: $('k-pod').value.trim(), namespace: $('k-ns').value.trim(), container: $('k-c').value.trim() };
  if (kind === 'docker') return { kind, container: $('d-c').value.trim() };
  if (kind === 'ssh') return { kind, hosts: splitList($('s-hosts').value) };
  return { kind: 'local' };
};
const opts = () => ({
  lang: $('lang').value,
  target: target(),
  hostlock: $('hostlock').value,
  newproc: $('newproc').checked,
  oneline: $('oneline').checked,
});

// ---------- argument panel ----------

function sampleValues() {
  if (scan.examples.length) return fillFromExample(scan, scan.examples[0]);
  const positional = scan.positional.map((p) => (!p.secret && (p.required || p.choices.length) ? p.sample : ''));
  const options = {};
  for (const o of scan.options) if (o.takesValue && /hours|name|namespace|region|env/i.test(o.flag)) options[o.flag] = o.sample;
  return { positional, options, extra: '' };
}

function setValues(v) {
  values.positional = [...(v.positional || [])];
  values.options = { ...(v.options || {}) };
  if (v.env) values.env = { ...v.env };
  if (v.ask) values.ask = { ...v.ask };
  values.extra = v.extra || '';
  syncFields();
  render();
}

function onField() {
  values.positional = scan.positional.map((p) => $(`pos-${p.index}`)?.value.trim() ?? '');
  values.options = {};
  scan.options.forEach((o, i) => {
    const f = $(`opt-${i}`);
    if (f) values.options[o.flag] = o.takesValue ? f.value.trim() : f.checked;
  });
  for (const e of scan.env) {
    values.env[e.name] = $(`env-${e.name}`)?.value.trim() ?? '';
    const ask = $(`ask-${e.name}`);
    if (ask) values.ask[e.name] = ask.checked;
    const input = $(`env-${e.name}`);
    if (input) input.disabled = !!values.ask[e.name];
  }
  values.extra = $('extra').value;
  render();
}

function syncFields() {
  scan.positional.forEach((p, i) => {
    const f = $(`pos-${p.index}`);
    if (f) f.value = values.positional[i] ?? '';
  });
  scan.options.forEach((o, i) => {
    const f = $(`opt-${i}`);
    if (!f) return;
    if (o.takesValue) f.value = values.options[o.flag] ?? '';
    else f.checked = values.options[o.flag] === true;
  });
  for (const e of scan.env) {
    const f = $(`env-${e.name}`);
    if (f) {
      f.value = values.env[e.name] ?? '';
      f.disabled = !!values.ask[e.name];
    }
    const a = $(`ask-${e.name}`);
    if (a) a.checked = !!values.ask[e.name];
  }
  $('extra').value = values.extra;
}

/** <label class="field"><span>…label…</span>control<small>hint</small></label> */
function field(labelKids, control, hint) {
  const l = make('label', { className: 'field' });
  l.append(appendAll(document.createElement('span'), labelKids), control);
  if (hint) l.append(make('small', { className: 'muted', textContent: hint }));
  return l;
}

function choiceSelect(choices, emptyLabel) {
  const s = document.createElement('select');
  s.append(new Option(emptyLabel, ''));
  for (const c of choices) s.append(new Option(c, c));
  return s;
}

function buildPanel() {
  const show = scan.hasArgs || forceArgs;
  $('argpanel').hidden = !show && !scan.env.length;
  $('noargs').hidden = show || !$('t').value.trim();
  if ($('argpanel').hidden) return;

  const ps = scan.lang === 'powershell';
  const parts = [];
  if (scan.positional.length) parts.push(`${scan.positional.length} ${ps ? 'parameter' : 'positional'}${ps && scan.positional.length > 1 ? 's' : ''}`);
  if (scan.options.length) parts.push(`${scan.options.length} ${ps ? 'switch' : 'option'}${scan.options.length > 1 ? (ps ? 'es' : 's') : ''}`);
  $('arg-summary').textContent = parts.length ? `Found ${parts.join(' and ')} in the script${scan.usage ? ' (from its usage text)' : ''}.` : scan.hasArgs ? '' : 'No arguments detected; type them below if needed.';

  const ex = $('arg-examples');
  ex.replaceChildren();
  ex.hidden = !scan.examples.length;
  if (scan.examples.length) {
    ex.append(make('span', { className: 'muted', textContent: 'Examples from the script:' }));
    for (const e of scan.examples) {
      const b = make('button', { type: 'button', textContent: e, title: 'Fill the fields with this example' });
      b.addEventListener('click', () => setValues(fillFromExample(scan, e)));
      ex.append(b);
    }
  }

  const pos = $('arg-fields');
  pos.replaceChildren();
  for (const p of scan.positional) {
    let control;
    if (p.secret) {
      control = make('input', { type: 'text', disabled: true, placeholder: 'PowerShell asks for this when it runs' });
    } else if (p.choices.length) {
      control = choiceSelect(p.choices, p.required ? 'choose…' : '(leave empty)');
    } else {
      control = make('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: p.default ? `default: ${p.default}` : `e.g. ${p.sample}` });
    }
    control.id = `pos-${p.index}`;
    control.addEventListener('input', onField);
    const tag = ps ? `-${p.name}` : p.variadic ? '$@' : scan.lang === 'python' ? '' : `$${p.index}`;
    const label = [
      tag ? make('span', { className: 'pos', textContent: tag }) : null,
      ps ? (p.type ? `[${p.type}]` : '') : p.label,
      p.required ? make('span', { className: 'req', textContent: 'required' }) : null,
    ];
    pos.append(field(label, control, p.help || (p.default && p.choices.length ? `default: ${p.default}` : '')));
  }

  const opts = $('opt-fields');
  opts.replaceChildren();
  scan.options.forEach((o, i) => {
    if (o.takesValue) {
      const control = o.choices?.length ? choiceSelect(o.choices, '(not set)') : make('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: o.default ? `default: ${o.default}` : `e.g. ${o.sample}` });
      control.id = `opt-${i}`;
      control.addEventListener('input', onField);
      opts.append(field([make('code', { textContent: o.flag }), o.label ? ` ${o.label}` : ''], control));
    } else {
      const box = make('input', { id: `opt-${i}`, type: 'checkbox' });
      box.addEventListener('change', onField);
      const l = make('label', { className: 'check' });
      l.append(box, make('code', { textContent: o.flag }), o.label ? ` ${o.label}` : '');
      opts.append(l);
    }
  });

  const envBox = $('env-box');
  const envFields = $('env-fields');
  envFields.replaceChildren();
  envBox.hidden = !scan.env.length;
  for (const e of scan.env) {
    if (!(e.name in values.ask)) values.ask[e.name] = SECRET_NAME.test(e.name);
    if (values.ask[e.name]) envBox.open = true;
    const control = make('input', { id: `env-${e.name}`, type: 'text', autocomplete: 'off', spellcheck: false, placeholder: e.default ? `default: ${e.default}` : 'not set' });
    control.addEventListener('input', onField);
    const ask = make('input', { id: `ask-${e.name}`, type: 'checkbox' });
    ask.addEventListener('change', onField);
    const askLabel = make('label', { className: 'check' });
    askLabel.append(ask, ' ask on server (hidden)');
    const wrapper = make('div');
    wrapper.append(field([make('code', { textContent: e.name })], control), askLabel);
    envFields.append(wrapper);
  }

  const pr = $('arg-prompts');
  pr.hidden = !scan.prompts.length;
  pr.textContent = scan.prompts.length ? `The script can also ask questions while it runs (${scan.prompts.map((p) => `“${p.replace(/:\s*$/, '')}”`).join(', ')}), usually when optional arguments are left empty. Answer them in the terminal.` : '';

  const sample = buildArgs(scan, sampleValues());
  $('arg-sample').textContent = sample || '(no arguments)';
  $('use-sample').hidden = !sample;
  syncFields();
}

function rescan() {
  const l = lang();
  $('lang').options[0].textContent = `Auto (${LANGS[detected()].label.split(' (')[0]})`;
  scan = scanArgs($('t').value, l);
  const key = JSON.stringify([l, scan.positional.map((p) => [p.label, p.choices, p.default]), scan.options.map((o) => [o.flag, o.takesValue]), scan.env.map((e) => e.name), scan.examples, scan.prompts, forceArgs]);
  if (key !== scanKey) {
    scanKey = key;
    buildPanel();
  } else {
    $('noargs').hidden = scan.hasArgs || forceArgs || !$('t').value.trim();
  }
  updateControls();
}

function updateControls() {
  const ps = lang() === 'powershell';
  $('sudo-label').textContent = ps ? 'Require administrator' : 'Run with sudo';
  $('newproc-box').hidden = !ps;
  $('target').disabled = ps;
  if (ps) $('target').value = 'local';
  const kind = $('target').value;
  $('target-kubectl').hidden = kind !== 'kubectl';
  $('target-docker').hidden = kind !== 'docker';
  $('target-ssh').hidden = kind !== 'ssh';
}

// ---------- command ----------

function issues(text) {
  const out = [];
  if (/\r/.test(text)) out.push(['info', "Windows line endings will be converted, so the interpreter won't choke on them."]);
  for (const label of findSecrets(text)) out.push(['err', `This script seems to contain ${label}. The command lands in shell history; pass secrets at run time instead.`]);
  const missing = scan.positional.filter((p, i) => p.required && !p.secret && !values.positional[i]).map((p) => p.label);
  if (text.trim() && missing.length) out.push(['info', `Required by the script: ${missing.join(', ')}. Without ${missing.length > 1 ? 'them' : 'it'} the script may stop or ask.`]);
  const l = lang();
  if (text.trim() && (l === 'bash' || l === 'sh') && !/^\s*set -[a-z]*e/m.test(text)) out.push(['info', 'Tip: add "set -euo pipefail" near the top so a failed step stops the script.']);
  if (text.trim() && l === 'powershell' && !/\$ErrorActionPreference\s*=\s*['"]Stop['"]/i.test(text)) out.push(['info', 'Tip: add $ErrorActionPreference = \'Stop\' near the top so a failed step stops the script.']);
  $('issues').replaceChildren(...out.map(([k, msg]) => make('li', { className: k, textContent: msg })));

  const dangers = text.trim() ? findDangers(text, l) : [];
  $('dangers').hidden = !dangers.length;
  $('dangers').replaceChildren(
    ...dangers.slice(0, 12).map((d) => {
      const li = make('li', { className: 'warn' });
      li.append(`Line ${d.line}: ${d.label} `, make('code', { textContent: d.code }));
      return li;
    }),
  );
}

function noteFor(l, kind, sudo) {
  if (l === 'powershell') return `Paste it into PowerShell (Windows PowerShell 5.1 or PowerShell 7).${sudo ? ' Open PowerShell with “Run as administrator” first.' : ''} Prompts inside the script still work.`;
  if (kind === 'kubectl') return 'Paste it into your own terminal, where kubectl points at the right cluster. Prompts inside the script still work.';
  if (kind === 'docker') return 'Paste it on the Docker host. Prompts inside the script still work.';
  if (kind === 'ssh') return 'Paste it into your own terminal. It connects to each host in turn; sudo or prompts are answered per host.';
  return `Paste it into the server's shell (bash, zsh or sh). It needs base64 and gunzip, which almost every Linux server has. ${sudo ? 'sudo may ask for your password first. ' : ''}Prompts inside the script still work.`;
}

async function render() {
  const text = $('t').value;
  const mine = ++seq;
  issues(text);
  if (!text.trim()) {
    $('out').hidden = true;
    $('size').textContent = '';
    return;
  }
  const sudo = $('sudo').checked;
  const l = lang();
  try {
    const o = {
      text, lang: l, name: $('name').value.trim() || fileName, args: argString(), env: envList(), secrets: askList(), sudo, expires,
      oneLine: $('oneline').checked, hosts: splitList($('hostlock').value), target: target(), newProcess: $('newproc').checked,
    };
    const compact = $('compact').checked;
    const res = await buildRunCommand({ ...o, compact });
    const full = compact ? (await buildRunCommand({ ...o, compact: false })).command : res.command;
    if (mine !== seq) return;
    $('cmd').textContent = res.command;
    $('pcmd').textContent = res.preview;
    const saved = full.length - res.command.length;
    $('size').textContent = `${fmtBytes(new TextEncoder().encode(text).length)} script → ${fmtBytes(res.command.length)} command` + (saved > 0 ? ` (compact saved ${fmtBytes(saved)})` : '');
    Object.assign($('until'), { textContent: `works until ${fmtWhen(expires)}`, className: 'badge' });
    Object.assign($('fp'), { textContent: `fingerprint ${res.fingerprint}`, className: 'badge mono' });
    $('cmd-note').textContent = noteFor(l, target().kind, sudo);
    $('notes').hidden = !res.notes.length;
    $('notes').replaceChildren(...res.notes.map((n) => make('li', { className: 'info', textContent: n })));
    $('out').hidden = false;
  } catch (e) {
    if (mine !== seq) return;
    $('out').hidden = true;
    $('size').textContent = '';
    $('issues').append(make('li', { className: 'err', textContent: e.message }));
  }
}

function onScript() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    resetExpiry();
    rescan();
    render();
  }, 200);
}

// ---------- load / share ----------

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_SCRIPT_BYTES) return toast(`That file is over ${fmtBytes(MAX_SCRIPT_BYTES)}`);
  fileName = file.name;
  $('t').value = await file.text();
  $('name').value = scriptName(file.name);
  resetExpiry();
  rescan();
  render();
}

function applyOpts(o) {
  if (!o) return;
  if (o.lang && [...$('lang').options].some((x) => x.value === o.lang)) $('lang').value = o.lang;
  const t = o.target || {};
  if (['local', 'kubectl', 'docker', 'ssh'].includes(t.kind)) $('target').value = t.kind;
  $('k-pod').value = t.pod || '';
  $('k-ns').value = t.namespace || '';
  $('k-c').value = t.kind === 'kubectl' ? t.container || '' : '';
  $('d-c').value = t.kind === 'docker' ? t.container || '' : '';
  $('s-hosts').value = (t.hosts || []).join(' ');
  $('hostlock').value = o.hostlock || '';
  $('newproc').checked = o.newproc !== false;
  $('oneline').checked = !!o.oneline;
}

async function loadShared(hash) {
  try {
    const s = await decodeShare(hash);
    $('t').value = s.text;
    $('name').value = s.name;
    $('sudo').checked = s.sudo;
    $('compact').checked = s.compact;
    applyOpts(s.opts);
    rescan();
    if (s.fields) setValues(s.fields);
    else if (s.args) setValues({ ...fillFromExample(scan, s.args) });
    expires = s.expires;
    const left = (s.expires - Date.now() / 1000) / 3600;
    const opt = [...$('hours').options].find((o) => Number(o.value) >= left) || $('hours').options[$('hours').options.length - 1];
    $('hours').value = opt.value;
    if (left <= 0) {
      $('issues').replaceChildren(make('li', { className: 'err', textContent: `This shared command expired on ${fmtWhen(s.expires)}. Pick a duration to make a fresh one.` }));
      $('out').hidden = true;
      return;
    }
    await render();
    $('out').scrollIntoView({ block: 'start' });
  } catch (e) {
    toast(e.message);
  }
}

function boot() {
  resetExpiry();
  $('t').addEventListener('input', onScript);
  for (const id of ['name', 'hostlock', 'k-pod', 'k-ns', 'k-c', 'd-c', 's-hosts']) $(id).addEventListener('input', render);
  $('extra').addEventListener('input', onField);
  for (const id of ['sudo', 'oneline', 'compact', 'newproc']) $(id).addEventListener('change', render);
  $('lang').addEventListener('change', () => {
    rescan();
    render();
  });
  $('target').addEventListener('change', () => {
    updateControls();
    render();
  });
  $('hours').addEventListener('change', () => {
    resetExpiry();
    render();
  });
  $('use-sample').addEventListener('click', () => setValues(sampleValues()));
  $('clear-args').addEventListener('click', () => setValues({ positional: [], options: {}, env: {}, extra: '' }));
  $('add-args').addEventListener('click', () => {
    forceArgs = true;
    scanKey = '';
    rescan();
    $('extra').focus();
  });
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  $('copy').addEventListener('click', () => copyText($('cmd').textContent, 'Command copied'));
  $('pcopy').addEventListener('click', () => copyText($('pcmd').textContent, 'Preview command copied'));
  $('copy-link').addEventListener('click', async () => {
    const state = { text: $('t').value, name: $('name').value.trim(), args: argString(), sudo: $('sudo').checked, expires, fields: values, compact: $('compact').checked, opts: opts() };
    const url = `${location.href.split('#')[0]}#${await encodeShare(state)}`;
    $('link-len').textContent = `${url.length.toLocaleString()} characters${url.length > LONG_LINK ? '; some chat apps cut long links, so check it arrives whole' : ''}`;
    copyText(url, 'Share link copied');
  });

  const form = $('run-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('dragover', (e) => {
    e.preventDefault();
    form.classList.add('drag');
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    form.classList.remove('drag');
    loadFile(e.dataTransfer.files[0]);
  });

  updateControls();
  if (location.hash.startsWith('#r1.')) {
    const h = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    loadShared(h);
  }
}

boot();
