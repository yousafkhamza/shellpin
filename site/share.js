import { parseLink, openLink, createLink, newPassphrase, safeName, LinkError, MAX_FILE_BYTES, MAX_HOURS } from './filelink.js';

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();
const LONG_LINK = 8000;

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtWhen = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const pageUrl = () => new URL('f.html', location.href).href.split('#')[0];

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copyText(text, what = 'Copied') {
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

function status(id, msg, cls = '') {
  Object.assign($(id), { textContent: msg, className: `status ${cls}` });
}

function download(name, bytes) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function asText(bytes) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\x00-\x08\x0e-\x1f]/.test(s) ? null : s;
  } catch {
    return null;
  }
}

// ---------- receive ----------
let link = null;

function showFile({ name, expires, bytes }) {
  const left = expires - Date.now() / 1000;
  $('r-pass-form').hidden = true;
  $('r-file').hidden = false;
  $('r-name').textContent = name;
  if (left <= 0) {
    Object.assign($('r-badge'), { textContent: 'expired', className: 'badge bad' });
    $('r-meta').textContent = `This link expired on ${fmtWhen(expires)}. Ask the sender for a new one.`;
    $('r-dl').disabled = true;
    return;
  }
  const hours = left / 3600;
  Object.assign($('r-badge'), {
    textContent: hours < 1 ? `${Math.ceil(left / 60)} min left` : hours < 48 ? `${Math.floor(hours)} h left` : `${Math.floor(hours / 24)} days left`,
    className: `badge ${hours < 2 ? 'warn' : ''}`,
  });
  $('r-meta').textContent = `${fmtBytes(bytes.length)} · opens until ${fmtWhen(expires)}`;
  $('r-dl').textContent = `Download ${name}`;
  $('r-dl').onclick = () => download(name, bytes);

  const text = asText(bytes);
  $('r-copy').hidden = $('r-show').hidden = text === null;
  if (text !== null) {
    $('r-copy').onclick = () => copyText(text, 'Contents copied');
    $('r-show').onclick = () => {
      const pre = $('r-text');
      pre.hidden = !pre.hidden;
      pre.textContent = pre.hidden ? '' : text;
      $('r-show').textContent = pre.hidden ? 'Show contents' : 'Hide contents';
    };
  }

  const isKey = /\.(pem|key)$/i.test(name) || /^id_[a-z0-9]+$/.test(name) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text || '');
  $('r-ssh').hidden = !isKey;
  if (isKey) {
    const user = name.replace(/\.(pem|key)$/i, '');
    $('r-ssh-nix').textContent = `chmod 600 ~/Downloads/${name}\nssh -i ~/Downloads/${name} ${user}@<server>`;
    $('r-ssh-win').textContent =
      `icacls "$HOME\\Downloads\\${name}" /inheritance:r /grant:r "$($env:USERNAME):R"\n` + `ssh -i "$HOME\\Downloads\\${name}" ${user}@<server>`;
  }
  status('r-status', '');
}

async function unlock(passphrase = '') {
  try {
    showFile(await openLink(link, passphrase));
  } catch (e) {
    status('r-status', e instanceof LinkError ? e.message : `Could not open the file (${e.message}).`, 'err');
    if (link.encrypted) $('r-pass').select();
  }
}

function startReceive(parsed) {
  link = parsed;
  for (const id of ['create', 'create-from-server', 'create-here', 'open']) $(id).hidden = true;
  $('receive').hidden = false;
  if (link.encrypted) {
    $('r-pass-form').hidden = false;
    $('r-pass').focus();
  } else {
    unlock();
  }
}

$('r-pass-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = $('r-pass').value.trim();
  if (!p) return status('r-status', 'Enter the passphrase.', 'err');
  status('r-status', 'Unlocking…');
  unlock(p);
});

// ---------- create ----------
let picked = null; // { name, bytes }

function setPicked(file, bytes) {
  picked = { name: file.name, bytes };
  $('c-file-info').textContent = `${file.name} · ${fmtBytes(bytes.length)}`;
  if (!$('c-name').value) $('c-name').value = safeName(file.name);
  $('c-text').value = '';
}

async function pickFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return status('c-status', `That file is ${fmtBytes(file.size)}; links hold up to ${fmtBytes(MAX_FILE_BYTES)}.`, 'err');
  setPicked(file, new Uint8Array(await file.arrayBuffer()));
  status('c-status', '');
}

async function make(e) {
  e.preventDefault();
  $('c-out').hidden = true;
  const text = $('c-text').value;
  const bytes = text ? te.encode(text.replace(/\r\n?/g, '\n')) : picked?.bytes;
  if (!bytes?.length) return status('c-status', 'Choose a file or paste some text first.', 'err');
  const name = safeName($('c-name').value.trim() || (text ? 'shared.txt' : picked.name));
  const usePass = $('c-usepass').checked;
  const pass = usePass ? $('c-pass').value.trim() : '';
  if (usePass && pass.length < 8) return status('c-status', 'Use a passphrase of at least 8 characters.', 'err');
  const hours = Math.min(Number($('c-hours').value), MAX_HOURS);
  try {
    status('c-status', 'Packing…');
    const url = await createLink(pageUrl(), { name, bytes, expires: Date.now() / 1000 + hours * 3600, passphrase: pass });
    $('c-link').textContent = url;
    $('c-len').textContent = `(${url.length.toLocaleString()} characters${url.length > LONG_LINK ? '; some chat apps cut long links, so check it arrives whole' : ''})`;
    $('c-pass-out').hidden = !pass;
    $('c-pass-show').textContent = pass;
    $('c-out').hidden = false;
    status('c-status', pass ? 'Done. Send the link and the passphrase through different channels.' : 'Done. Anyone with this link can open the file.', 'ok');
  } catch (err) {
    status('c-status', err instanceof LinkError ? err.message : `Could not make the link (${err.message}).`, 'err');
  }
}

function startCreate() {
  for (const id of ['create', 'create-from-server', 'create-here', 'open']) $(id).hidden = false;
  $('srv-cmd').textContent = `curl -fsSL ${new URL('s/share.sh', pageUrl()).href} | bash -s -- ./jatin.pem --hours 24`;
  $('srv-copy').addEventListener('click', () => copyText($('srv-cmd').textContent));
  $('c-pass').value = newPassphrase();
  $('c-regen').addEventListener('click', () => ($('c-pass').value = newPassphrase()));
  $('c-usepass').addEventListener('change', () => ($('c-pass-row').hidden = !$('c-usepass').checked));
  $('c-file').addEventListener('change', (e) => pickFile(e.target.files[0]));
  $('c-text').addEventListener('input', () => {
    if ($('c-text').value) {
      picked = null;
      $('c-file-info').textContent = '';
    }
  });
  $('c-copy-link').addEventListener('click', () => copyText($('c-link').textContent, 'Link copied'));
  $('c-copy-pass').addEventListener('click', () => copyText($('c-pass-show').textContent, 'Passphrase copied'));
  const form = $('c-form');
  form.addEventListener('submit', make);
  form.addEventListener('dragover', (e) => {
    e.preventDefault();
    form.classList.add('drag');
  });
  form.addEventListener('dragleave', () => form.classList.remove('drag'));
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    form.classList.remove('drag');
    pickFile(e.dataTransfer.files[0]);
  });
  $('o-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      startReceive(parseLink($('o-link').value));
      $('o-link').value = '';
    } catch (err) {
      status('o-status', err.message, 'err');
    }
  });
}

// ---------- boot ----------
const hash = location.hash;
if (hash.startsWith('#f1.')) {
  // Take the file out of the address bar and this history entry as soon as it's read.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    startReceive(parseLink(hash));
  } catch (e) {
    startCreate();
    status('o-status', e.message, 'err');
  }
} else {
  startCreate();
}
