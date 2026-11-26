// Shared by the build (Node) and the publish form (browser). No dependencies.

export const MAX_DAYS = 365;
// `bash -c "$s"` passes the script as one argument; Linux caps one argument at 128 KiB.
export const MAX_BYTES = 120_000;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const META_KEYS = ['description', 'usage', 'expires'];
const HEADER_LINES = 40;

// Pages is public and git history is forever: refuse anything that looks like a credential.
const SECRET_PATTERNS = [
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['an AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an AWS secret key assignment', /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}/i],
];

/** Labels of credentials found in the text (empty when none). */
export const findSecrets = (text) => SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);

export const isoDay = (d) => d.toISOString().slice(0, 10);

export function isValidDay(s) {
  return DATE_RE.test(s) && isoDay(new Date(`${s}T00:00:00Z`)) === s;
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Reads `# @key value` tags from the top of a script. */
export function parseMeta(text) {
  const meta = {};
  for (const line of text.split('\n').slice(0, HEADER_LINES)) {
    const m = /^#\s*@([a-z]+)\s+(.*?)\s*$/i.exec(line);
    const key = m?.[1].toLowerCase();
    if (key && META_KEYS.includes(key) && !(key in meta)) meta[key] = m[2];
  }
  return meta;
}

/** Writes the tags into the script header, replacing old ones. Normalises CRLF to LF. */
export function applyMeta(text, meta) {
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines = lines.filter((l, i) => i >= HEADER_LINES || !/^#\s*@(description|usage|expires)\b/i.test(l));
  const tags = META_KEYS.filter((k) => meta[k]).map((k) => `# @${k} ${String(meta[k]).replace(/\s+/g, ' ').trim()}`);
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  if (at === 0) lines.unshift('#!/bin/bash');
  lines.splice(1, 0, ...tags);
  return lines.join('\n');
}

/** What `s="$(curl ...)"` holds: command substitution drops trailing newlines. */
export const shellPayload = (text) => text.replace(/\n+$/, '');

/**
 * Checks one script. `expired` is not an error: the build skips it and the prune job deletes it.
 * @returns {{ meta: object, errors: string[], expired: boolean, daysLeft: number|null }}
 */
export function checkScript(name, text, today, { maxDays = MAX_DAYS, maxBytes = MAX_BYTES } = {}) {
  const errors = [];
  const meta = parseMeta(text);
  if (!NAME_RE.test(name)) errors.push('Name must be lowercase letters, digits and dashes (max 63), starting with a letter or digit.');
  const bytes = new TextEncoder().encode(text).length;
  if (bytes === 0) errors.push('Script is empty.');
  if (bytes > maxBytes) errors.push(`Script is ${bytes} bytes; the limit is ${maxBytes}.`);
  if (text.includes('\r')) errors.push('Script has Windows (CRLF) line endings; bash will fail on them. Save it with LF endings.');
  if (text.includes('\0')) errors.push('Script contains NUL bytes.');
  if (bytes && !text.startsWith('#!')) errors.push('Script must start with a shebang, for example #!/bin/bash.');
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) errors.push(`Script appears to contain ${label}. Everything here is public; pass secrets at run time instead.`);
  }

  let daysLeft = null;
  if (!meta.expires) {
    errors.push(`Missing "# @expires YYYY-MM-DD" in the first ${HEADER_LINES} lines.`);
  } else if (!isValidDay(meta.expires)) {
    errors.push(`@expires "${meta.expires}" is not a valid YYYY-MM-DD date.`);
  } else {
    daysLeft = daysBetween(today, meta.expires);
    if (daysLeft > maxDays) errors.push(`@expires ${meta.expires} is ${daysLeft} days away; the limit is ${maxDays} (${addDays(today, maxDays)}).`);
  }
  return { meta, errors, expired: daysLeft !== null && daysLeft <= 0, daysLeft };
}
