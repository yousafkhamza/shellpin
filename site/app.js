import { checkScript, applyMeta, addDays, daysBetween, isoDay, isValidDay, NAME_RE } from './rules.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'shellpin.token';
const GH_URL_SOFT_LIMIT = 8000;

const state = { manifest: null, scripts: [], current: null, today: isoDay(new Date()) };

// ---------- helpers ----------
const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function expiryBadge(expires) {
  const left = daysBetween(state.today, expires);
  if (left <= 0) return { text: 'expired', cls: 'bad' };
  if (left === 1) return { text: 'last day', cls: 'warn' };
  return { text: `${left} days left`, cls: left <= 7 ? 'warn' : '' };
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

function repoInfo() {
  const m = state.manifest;
  if (m?.repo) return { repo: m.repo, branch: m.branch || 'main' };
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  const name = location.pathname.split('/').filter(Boolean)[0];
  return owner && name ? { repo: `${owner}/${name}`, branch: 'main' } : null;
}

const siteUrl = (path) => new URL(path, document.baseURI.replace(/[?#].*$/, '')).href;

// ---------- run command ----------
export function buildCommand(s, args, { verify, sudo }) {
  const url = siteUrl(`s/${s.name}.sh`);
  const bash = sudo ? 'sudo bash' : 'bash';
  const a = args.trim() ? ` ${args.trim()}` : '';
  if (!verify) return `curl -fsSL ${url} | ${bash} -s --${a}`;
  return (
    `if s="$(curl -fsSL ${url})" && [ "$(printf '%s' "$s" | sha256sum | cut -d' ' -f1)" = ${s.shellSha256} ]; ` +
    `then ${bash} -c "$s" ${s.name}${a}; ` +
    `else echo "shellpin: download failed or checksum mismatch" >&2; fi`
  );
}

function renderCommand() {
  const s = state.current;
  if (!s) return;
  const verify = $('o-verify').checked;
  $('d-cmd').textContent = buildCommand(s, $('d-args').value, { verify, sudo: $('o-sudo').checked });
  $('d-note').textContent = verify
    ? 'Tied to this version of the script. If the script is edited, this command refuses to run; copy a new one.'
    : 'Runs whatever the URL serves at that moment. -f makes curl fail loudly on a 404 (an expired script) instead of piping an error page into bash.';
}

// ---------- list + detail ----------
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const items = state.scripts.filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
  const list = $('list');
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.scripts.length ? 'No scripts match that filter.' : 'No scripts published yet. Add one below.';
    list.append(li);
  }
  for (const s of items) {
    const b = expiryBadge(s.expires);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-current', String(state.current?.name === s.name));
    const name = document.createElement('span');
    name.className = 'name';
    const badge = Object.assign(document.createElement('span'), { className: `badge ${b.cls}`, textContent: b.text });
    name.append(Object.assign(document.createElement('span'), { textContent: `${s.name}.sh` }), badge);
    btn.append(name, Object.assign(document.createElement('span'), { className: 'd', textContent: s.description || 'No description' }));
    btn.addEventListener('click', () => select(s.name, true));
    li.append(btn);
    list.append(li);
  }
  const n = state.scripts.length;
  $('count').textContent = q ? `${items.length} of ${n}` : `${n} script${n === 1 ? '' : 's'}`;
}

function select(name, focusArgs = false) {
  const s = state.scripts.find((x) => x.name === name);
  state.current = s || null;
  const url = new URL(location.href);
  s ? url.searchParams.set('s', name) : url.searchParams.delete('s');
  history.replaceState(null, '', url);
  renderList();
  $('placeholder').hidden = !!s;
  $('detail-body').hidden = !s;
  if (!s) return;

  const b = expiryBadge(s.expires);
  $('d-name').textContent = `${s.name}.sh`;
  Object.assign($('d-badge'), { textContent: b.text, className: `badge ${b.cls}` });
  $('d-desc').textContent = s.description || '';
  $('d-exp').textContent = fmtDate(s.expires);
  $('d-size').textContent = `${fmtBytes(s.bytes)} · ${s.lines} lines`;
  $('d-sha').textContent = s.sha256;
  $('d-sha').title = s.sha256;
  $('d-args').value = '';
  $('d-args').placeholder = s.usage || 'arguments passed to the script';
  $('d-usage').textContent = s.usage ? `Usage: ${s.name}.sh ${s.usage}` : '';
  $('d-raw').href = siteUrl(`s/${s.name}.sh`);
  const r = repoInfo();
  $('d-edit').hidden = !r;
  if (r) $('d-edit').href = `https://github.com/${r.repo}/edit/${r.branch}/scripts/${s.name}.sh`;
  $('d-src').hidden = true;
  $('d-src').replaceChildren();
  $('d-src-btn').textContent = 'Show source';
  renderCommand();
  if (focusArgs) $('d-args').focus({ preventScroll: matchMedia('(min-width: 821px)').matches });
}

async function toggleSource() {
  const pre = $('d-src');
  if (!pre.hidden) {
    pre.hidden = true;
    $('d-src-btn').textContent = 'Show source';
    return;
  }
  if (!pre.childElementCount) {
    const name = state.current.name;
    try {
      const res = await fetch(siteUrl(`s/${name}.sh`), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (state.current?.name !== name) return;
      for (const line of text.replace(/\n$/, '').split('\n')) pre.append(Object.assign(document.createElement('span'), { textContent: line || ' ' }));
    } catch (e) {
      toast(`Could not load source (${e.message})`);
      return;
    }
  }
  pre.hidden = false;
  $('d-src-btn').textContent = 'Hide source';
}

// ---------- publish ----------
function expiryDay() {
  const v = $('p-exp').value;
  return v === 'custom' ? $('p-date').value : addDays(state.today, Number(v));
}

function draft() {
  const name = $('p-name').value.trim().replace(/\.sh$/, '');
  const meta = { description: $('p-desc').value.trim(), usage: $('p-usage').value.trim(), expires: expiryDay() };
  const body = $('p-body').value;
  const text = body.trim() ? applyMeta(body, meta) + (body.endsWith('\n') ? '' : '\n') : '';
  return { name, meta, text };
}

function validateDraft() {
  const { name, meta, text } = draft();
  const issues = [];
  const max = state.manifest?.maxDays ?? 365;
  const exp = meta.expires;
  $('p-exp-on').textContent = isValidDay(exp) ? `Removed on ${fmtDate(exp)} (UTC)` : '';
  if (!name) issues.push(['err', 'Give the script a name.']);
  else if (!NAME_RE.test(name)) issues.push(['err', 'Name: lowercase letters, digits and dashes only.']);
  if (!text) issues.push(['err', 'Paste or load a script.']);
  if (text) {
    const r = checkScript(name || 'x', text, state.today, { maxDays: max, maxBytes: state.manifest?.maxBytes });
    for (const e of r.errors) if (!(e.startsWith('Name') && !name)) issues.push(['err', e]);
    if (r.expired) issues.push(['err', 'Pick an expiry date after today.']);
  }
  if (name && state.scripts.some((s) => s.name === name)) issues.push(['info', `${name}.sh already exists; publishing replaces it.`]);
  if (/\r/.test($('p-body').value)) issues.push(['info', 'Windows line endings will be converted to LF.']);
  if (text && !/^set -[a-z]*e/m.test(text)) issues.push(['info', 'Tip: start with "set -euo pipefail" so a failed step stops the script.']);
  const errors = issues.some(([k]) => k === 'err');
  if (!errors && text) issues.push(['ok', `Ready: ${name}.sh, ${fmtBytes(new TextEncoder().encode(text).length)}, expires ${fmtDate(exp)}.`]);

  $('p-issues').replaceChildren(...issues.map(([k, msg]) => Object.assign(document.createElement('li'), { className: k, textContent: msg })));
  $('p-size').textContent = text ? fmtBytes(new TextEncoder().encode(text).length) : '';
  $('p-go').disabled = errors;
  $('p-dl').disabled = errors;
  $('p-go').textContent = $('p-token').value.trim() ? 'Commit to repository' : 'Continue on GitHub';
  return !errors;
}

function setStatus(msg, cls = '') {
  const el = $('p-status');
  el.className = `status ${cls}`;
  el.replaceChildren();
  if (typeof msg === 'string') el.textContent = msg;
  else el.append(...msg);
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function commitWithToken(r, { name, meta, text }, token) {
  const path = `scripts/${name}.sh`;
  const api = `https://api.github.com/repos/${r.repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  setStatus('Committing…');
  const head = await fetch(`${api}?ref=${encodeURIComponent(r.branch)}`, { headers, cache: 'no-store' });
  if (head.status === 401) throw new Error('GitHub rejected the token (401). Check it has not expired.');
  if (!head.ok && head.status !== 404) throw new Error(`Could not read ${path} (HTTP ${head.status}). Does the token have access to ${r.repo}?`);
  const sha = head.ok ? (await head.json()).sha : undefined;
  const res = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: `${sha ? 'update' : 'add'} ${name}.sh (expires ${meta.expires})`, content: toBase64(text), branch: r.branch, sha }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub said ${res.status}: ${err.message || res.statusText}. The token needs Contents: read and write on ${r.repo}.`);
  }
  const link = Object.assign(document.createElement('a'), { href: `https://github.com/${r.repo}/actions`, target: '_blank', rel: 'noopener', textContent: 'Watch the deploy' });
  setStatus([`Committed ${path}. It goes live once the Pages workflow finishes (about a minute). `, link], 'ok');
}

function openOnGitHub(r, { name, text }) {
  const url = `https://github.com/${r.repo}/new/${r.branch}?filename=${encodeURIComponent(`scripts/${name}.sh`)}&value=${encodeURIComponent(text)}`;
  if (url.length > GH_URL_SOFT_LIMIT) {
    setStatus('This script is too long to pass in a link. Add a token above, or download the file and upload it to scripts/ on GitHub.', 'err');
    return;
  }
  if (state.scripts.some((s) => s.name === name)) {
    setStatus('That name already exists. GitHub cannot pre-fill an existing file, so use "Edit or renew on GitHub" on the script, or add a token.', 'err');
    return;
  }
  window.open(url, '_blank', 'noopener');
  setStatus('Opened GitHub. Commit the file there and the Pages workflow publishes it.', 'ok');
}

async function onPublish(e) {
  e.preventDefault();
  if (!validateDraft()) return;
  const r = repoInfo();
  if (!r) return setStatus('Cannot tell which repository this site belongs to. Download the file and add it to scripts/ yourself.', 'err');
  const d = draft();
  const token = $('p-token').value.trim();
  $('p-go').disabled = true;
  try {
    if (token) await commitWithToken(r, d, token);
    else openOnGitHub(r, d);
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    $('p-go').disabled = false;
  }
}

function download() {
  if (!validateDraft()) return;
  const { name, text } = draft();
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/x-sh' })), download: `${name}.sh` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 512_000) return setStatus('That file is too large for a script.', 'err');
  const text = await file.text();
  $('p-body').value = text;
  const m = /^(?:.*\/)?([^/]+?)(?:\.(?:sh|bash))?$/.exec(file.name);
  if (!$('p-name').value && m) $('p-name').value = m[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  // Pre-fill the form from tags already in the file.
  for (const [key, id] of [['description', 'p-desc'], ['usage', 'p-usage']]) {
    const t = new RegExp(`^#\\s*@${key}\\s+(.*)$`, 'mi').exec(text);
    if (t && !$(id).value) $(id).value = t[1].trim();
  }
  validateDraft();
}

function setupPublish() {
  const max = state.manifest?.maxDays ?? 365;
  Object.assign($('p-date'), { min: addDays(state.today, 1), max: addDays(state.today, max), value: addDays(state.today, 30) });
  $('p-token').value = sessionStorage.getItem(TOKEN_KEY) || '';
  if ($('p-token').value) $('token-box').open = true;

  const form = $('pub');
  form.addEventListener('input', validateDraft);
  form.addEventListener('submit', onPublish);
  $('p-exp').addEventListener('change', () => {
    $('p-date').hidden = $('p-exp').value !== 'custom';
    validateDraft();
  });
  $('p-token').addEventListener('change', () => {
    const v = $('p-token').value.trim();
    v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY);
  });
  $('p-forget').addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    $('p-token').value = '';
    validateDraft();
    toast('Token removed');
  });
  $('p-dl').addEventListener('click', download);
  $('p-file').addEventListener('change', (e) => loadFile(e.target.files[0]));
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
  validateDraft();
  setStatus('');
}

// ---------- boot ----------
async function boot() {
  try {
    const res = await fetch('scripts.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.manifest = await res.json();
    // Hide anything that expired since the last build, so the page never offers a dead link.
    state.scripts = state.manifest.scripts.filter((s) => daysBetween(state.today, s.expires) > 0);
  } catch (e) {
    $('count').textContent = `Could not load scripts.json (${e.message})`;
  }
  if (state.manifest) $('generated').textContent = `Site built ${fmtDate(state.manifest.generated)}`;
  const r = repoInfo();
  if (r) Object.assign($('repo-link'), { href: `https://github.com/${r.repo}`, hidden: false });

  $('q').addEventListener('input', renderList);
  for (const id of ['d-args', 'o-verify', 'o-sudo']) $(id).addEventListener('input', renderCommand);
  $('copy').addEventListener('click', () => copyText($('d-cmd').textContent));
  $('d-src-btn').addEventListener('click', toggleSource);

  renderList();
  const want = new URL(location.href).searchParams.get('s');
  if (want) select(want);
  setupPublish();
}

boot();
