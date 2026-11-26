import { buildRunCommand, encodeShare, decodeShare, scriptName, MAX_SCRIPT_BYTES, MAX_HOURS } from './runcmd.js';
import { scanArgs, buildArgs, fillFromExample } from './argscan.js';
import { findSecrets } from './rules.js';

const $ = (id) => document.getElementById(id);
function appendAll(node, kids) {
  for (const k of kids.flat()) if (k != null && k !== false) node.append(k);
  return node;
}
const LONG_LINK = 8000;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtWhen = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Expiry is fixed when the script or duration changes, not on every keystroke in the argument fields,
// so the command doesn't change under you while you copy it.
let expires = 0;
let seq = 0;
let timer;

// What the script takes, and what the person filled in. Values survive re-scans (keyed by position/flag/name).
let scan = scanArgs('');
let scanKey = '';
let forceArgs = false;
const values = { positional: [], options: {}, env: {}, extra: '' };

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

const argString = () => buildArgs(scan, values);
const envList = () => scan.env.map((e) => [e.name, values.env[e.name] ?? '']);

// ---------- argument panel ----------

function sampleValues() {
  if (scan.examples.length) return fillFromExample(scan, scan.examples[0]);
  const positional = scan.positional.map((p) => (p.required || p.choices.length ? p.sample : ''));
  const options = {};
  for (const o of scan.options) if (o.takesValue && /hours|name|namespace|region|env/i.test(o.flag)) options[o.flag] = o.sample;
  return { positional, options, extra: '' };
}

function setValues(v) {
  values.positional = [...(v.positional || [])];
  values.options = { ...(v.options || {}) };
  if (v.env) values.env = { ...v.env };
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
  for (const e of scan.env) values.env[e.name] = $(`env-${e.name}`)?.value.trim() ?? '';
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
    if (f) f.value = values.env[e.name] ?? '';
  }
  $('extra').value = values.extra;
}

/** <label class="field"><span>…label…</span>control<small>hint</small></label> */
function field(labelKids, control, hint) {
  const l = Object.assign(document.createElement('label'), { className: 'field' });
  l.append(appendAll(document.createElement('span'), labelKids), control);
  if (hint) l.append(Object.assign(document.createElement('small'), { className: 'muted', textContent: hint }));
  return l;
}

function buildPanel() {
  const show = scan.hasArgs || forceArgs;
  $('argpanel').hidden = !show;
  $('noargs').hidden = show || !$('t').value.trim();
  if (!show) return;

  const parts = [];
  if (scan.positional.length) parts.push(`${scan.positional.length} positional`);
  if (scan.options.length) parts.push(`${scan.options.length} option${scan.options.length > 1 ? 's' : ''}`);
  $('arg-summary').textContent = scan.hasArgs ? `Found ${parts.join(' and ')} in the script${scan.usage ? ' (from its usage text)' : ''}.` : 'None detected; type them below.';

  // Examples the script itself documents.
  const ex = $('arg-examples');
  ex.replaceChildren();
  ex.hidden = !scan.examples.length;
  if (scan.examples.length) {
    ex.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Examples from the script:' }));
    for (const e of scan.examples) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: e, title: 'Fill the fields with this example' });
      b.addEventListener('click', () => setValues(fillFromExample(scan, e)));
      ex.append(b);
    }
  }

  const pos = $('arg-fields');
  pos.replaceChildren();
  for (const p of scan.positional) {
    let control;
    if (p.choices.length) {
      control = document.createElement('select');
      control.append(new Option(p.required ? 'choose…' : '(leave empty)', ''));
      for (const c of p.choices) control.append(new Option(c, c));
    } else {
      control = Object.assign(document.createElement('input'), { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: p.default ? `default: ${p.default}` : `e.g. ${p.sample}` });
    }
    control.id = `pos-${p.index}`;
    control.addEventListener('input', onField);
    const label = [
      Object.assign(document.createElement('span'), { className: 'pos', textContent: p.variadic ? '$@' : `$${p.index}` }),
      p.label,
      p.required ? Object.assign(document.createElement('span'), { className: 'req', textContent: 'required' }) : null,
    ];
    pos.append(field(label, control, p.default && p.choices.length ? `default: ${p.default}` : ''));
  }

  const opts = $('opt-fields');
  opts.replaceChildren();
  scan.options.forEach((o, i) => {
    if (o.takesValue) {
      const control = Object.assign(document.createElement('input'), { id: `opt-${i}`, type: 'text', autocomplete: 'off', spellcheck: false, placeholder: `e.g. ${o.sample}` });
      control.addEventListener('input', onField);
      opts.append(field([Object.assign(document.createElement('code'), { textContent: o.flag }), o.label ? ` ${o.label}` : ''], control));
    } else {
      const box = Object.assign(document.createElement('input'), { id: `opt-${i}`, type: 'checkbox' });
      box.addEventListener('change', onField);
      const l = Object.assign(document.createElement('label'), { className: 'check' });
      l.append(box, Object.assign(document.createElement('code'), { textContent: o.flag }));
      opts.append(l);
    }
  });

  const envBox = $('env-box');
  const envFields = $('env-fields');
  envFields.replaceChildren();
  envBox.hidden = !scan.env.length;
  for (const e of scan.env) {
    const control = Object.assign(document.createElement('input'), { id: `env-${e.name}`, type: 'text', autocomplete: 'off', spellcheck: false, placeholder: e.default ? `default: ${e.default}` : 'not set' });
    control.addEventListener('input', onField);
    envFields.append(field([Object.assign(document.createElement('code'), { textContent: e.name })], control));
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
  scan = scanArgs($('t').value);
  const key = JSON.stringify([scan.positional.map((p) => [p.label, p.choices, p.default]), scan.options.map((o) => [o.flag, o.takesValue]), scan.env.map((e) => e.name), scan.examples, scan.prompts]);
  if (key !== scanKey) {
    scanKey = key;
    buildPanel();
  } else {
    $('noargs').hidden = scan.hasArgs || forceArgs || !$('t').value.trim();
  }
}

// ---------- command ----------

function issues(text) {
  const out = [];
  if (/\r/.test(text)) out.push(['info', "Windows line endings will be converted, so bash won't choke on them."]);
  for (const label of findSecrets(text)) out.push(['err', `This script seems to contain ${label}. The command lands in shell history; pass secrets at run time instead.`]);
  const missing = scan.positional.filter((p, i) => p.required && !values.positional[i]).map((p) => p.label);
  if (text.trim() && missing.length) out.push(['info', `Required by the script: ${missing.join(', ')}. Without ${missing.length > 1 ? 'them' : 'it'} the script may stop or ask.`]);
  if (text.trim() && !/^\s*set -[a-z]*e/m.test(text)) out.push(['info', 'Tip: add "set -euo pipefail" near the top so a failed step stops the script.']);
  $('issues').replaceChildren(...out.map(([k, msg]) => Object.assign(document.createElement('li'), { className: k, textContent: msg })));
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
  try {
    const opts = { text, name: $('name').value.trim(), args: argString(), env: envList(), sudo, expires, oneLine: $('oneline').checked };
    const compact = $('compact').checked;
    const { command } = await buildRunCommand({ ...opts, compact });
    const full = compact ? (await buildRunCommand({ ...opts, compact: false })).command : command;
    if (mine !== seq) return;
    $('cmd').textContent = command;
    const saved = full.length - command.length;
    $('size').textContent = `${fmtBytes(new TextEncoder().encode(text).length)} script → ${fmtBytes(command.length)} command` + (saved > 0 ? ` (compact saved ${fmtBytes(saved)})` : '');
    Object.assign($('until'), { textContent: `works until ${fmtWhen(expires)}`, className: 'badge' });
    $('cmd-note').textContent =
      "Paste it into the server's shell (bash, zsh or sh). It needs base64 and gunzip, which almost every Linux server has. " +
      `${sudo ? 'sudo may ask for your password first. ' : ''}Prompts inside the script still work.`;
    $('out').hidden = false;
  } catch (e) {
    if (mine !== seq) return;
    $('out').hidden = true;
    $('size').textContent = '';
    $('issues').append(Object.assign(document.createElement('li'), { className: 'err', textContent: e.message }));
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
  $('t').value = await file.text();
  $('name').value = scriptName(file.name);
  resetExpiry();
  rescan();
  render();
}

async function loadShared(hash) {
  try {
    const s = await decodeShare(hash);
    $('t').value = s.text;
    $('name').value = s.name;
    $('sudo').checked = s.sudo;
    $('compact').checked = s.compact;
    rescan();
    if (s.fields) setValues(s.fields);
    else if (s.args) setValues({ ...fillFromExample(scan, s.args) });
    expires = s.expires;
    const left = (s.expires - Date.now() / 1000) / 3600;
    const opt = [...$('hours').options].find((o) => Number(o.value) >= left) || $('hours').options[$('hours').options.length - 1];
    $('hours').value = opt.value;
    if (left <= 0) {
      $('issues').replaceChildren(Object.assign(document.createElement('li'), { className: 'err', textContent: `This shared command expired on ${fmtWhen(s.expires)}. Pick a duration to make a fresh one.` }));
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
  $('name').addEventListener('input', render);
  $('extra').addEventListener('input', onField);
  for (const id of ['sudo', 'oneline', 'compact']) $(id).addEventListener('change', render);
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
  $('copy-link').addEventListener('click', async () => {
    const url = `${location.href.split('#')[0]}#${await encodeShare({ text: $('t').value, name: $('name').value.trim(), args: argString(), sudo: $('sudo').checked, expires, fields: values, compact: $('compact').checked })}`;
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

  if (location.hash.startsWith('#r1.')) {
    const h = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    loadShared(h);
  }
}

boot();
