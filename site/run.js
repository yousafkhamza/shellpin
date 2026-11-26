import { buildRunCommand, encodeShare, decodeShare, scriptName, MAX_SCRIPT_BYTES, MAX_HOURS } from './runcmd.js';
import { findSecrets } from './rules.js';

const $ = (id) => document.getElementById(id);
const LONG_LINK = 8000;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtWhen = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Expiry is fixed when the script or duration changes, not on every keystroke in "Arguments",
// so the command doesn't change under you while you copy it.
let expires = 0;
let seq = 0;
let timer;

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

const state = () => ({
  text: $('t').value,
  name: $('name').value.trim(),
  args: $('args').value,
  sudo: $('sudo').checked,
  expires,
});

function resetExpiry() {
  expires = Math.floor(Date.now() / 1000) + Math.min(Number($('hours').value), MAX_HOURS) * 3600;
}

function issues(text) {
  const out = [];
  if (/\r/.test(text)) out.push(['info', 'Windows line endings will be converted, so bash won\'t choke on them.']);
  for (const label of findSecrets(text)) out.push(['err', `This script seems to contain ${label}. The command lands in shell history; pass secrets at run time instead.`]);
  if (text.trim() && !/^\s*set -[a-z]*e/m.test(text)) out.push(['info', 'Tip: add "set -euo pipefail" near the top so a failed step stops the script.']);
  $('issues').replaceChildren(...out.map(([k, msg]) => Object.assign(document.createElement('li'), { className: k, textContent: msg })));
}

async function render() {
  const s = state();
  const mine = ++seq;
  issues(s.text);
  if (!s.text.trim()) {
    $('out').hidden = true;
    $('size').textContent = '';
    return;
  }
  try {
    const { command, scriptBytes } = await buildRunCommand({ ...s, oneLine: $('oneline').checked });
    if (mine !== seq) return;
    $('cmd').textContent = command;
    $('size').textContent = `${fmtBytes(scriptBytes)} script → ${fmtBytes(command.length)} command`;
    Object.assign($('until'), { textContent: `works until ${fmtWhen(s.expires)}`, className: 'badge' });
    $('cmd-note').textContent =
      `Paste it into the server's shell (bash, zsh or sh). It needs base64 and gunzip, which almost every Linux server has. ` +
      `${s.sudo ? 'sudo may ask for your password first. ' : ''}Prompts inside the script still work.`;
    $('out').hidden = false;
  } catch (e) {
    if (mine !== seq) return;
    $('out').hidden = true;
    $('size').textContent = '';
    $('issues').append(Object.assign(document.createElement('li'), { className: 'err', textContent: e.message }));
  }
}

const soon = () => {
  clearTimeout(timer);
  timer = setTimeout(render, 150);
};

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_SCRIPT_BYTES) return toast(`That file is over ${fmtBytes(MAX_SCRIPT_BYTES)}`);
  $('t').value = await file.text();
  $('name').value = scriptName(file.name);
  resetExpiry();
  render();
}

async function loadShared(hash) {
  try {
    const s = await decodeShare(hash);
    $('t').value = s.text;
    $('name').value = s.name;
    $('args').value = s.args;
    $('sudo').checked = s.sudo;
    expires = s.expires;
    // Pick the closest duration so editing keeps a sensible choice.
    const left = (s.expires - Date.now() / 1000) / 3600;
    const opt = [...$('hours').options].find((o) => Number(o.value) >= left) || $('hours').options[$('hours').options.length - 1];
    $('hours').value = opt.value;
    if (left <= 0) {
      $('issues').replaceChildren(Object.assign(document.createElement('li'), { className: 'err', textContent: `This shared command expired on ${fmtWhen(s.expires)}. Pick a new duration to make a fresh one.` }));
      $('t').focus();
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
  for (const id of ['t', 'name']) $(id).addEventListener('input', () => { resetExpiry(); soon(); });
  $('args').addEventListener('input', soon);
  for (const id of ['sudo', 'oneline']) $(id).addEventListener('change', render);
  $('hours').addEventListener('change', () => { resetExpiry(); render(); });
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  $('copy').addEventListener('click', () => copyText($('cmd').textContent, 'Command copied'));
  $('copy-link').addEventListener('click', async () => {
    const url = `${location.href.split('#')[0]}#${await encodeShare(state())}`;
    $('link-len').textContent = `${url.length.toLocaleString()} characters${url.length > LONG_LINK ? '; some chat apps cut long links, so check it arrives whole' : ''}`;
    copyText(url, 'Share link copied');
  });

  const form = $('run-form');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('dragover', (e) => { e.preventDefault(); form.classList.add('drag'); });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => { e.preventDefault(); form.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });

  if (location.hash.startsWith('#r1.')) {
    const h = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    loadShared(h);
  }
}

boot();
