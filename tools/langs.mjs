// Language support: detection, safe compaction, and where the shellpin prelude can be inserted.
// Languages: 'bash', 'sh' (POSIX / BusyBox), 'powershell', 'python'.

export const LANGS = {
  bash: { label: 'Bash' },
  sh: { label: 'sh (POSIX, BusyBox, Alpine)' },
  powershell: { label: 'PowerShell' },
  python: { label: 'Python 3' },
};

/** Best guess from the file name, the shebang, then the content. */
export function detectLang(text, fileName = '') {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'ps1' || ext === 'psm1') return 'powershell';
  if (ext === 'py') return 'python';
  const first = String(text).replace(/^\uFEFF/, '').split('\n', 1)[0];
  if (/^#!.*\bpython/.test(first)) return 'python';
  if (/^#!.*\b(pwsh|powershell)\b/.test(first)) return 'powershell';
  if (/^#!\s*(\/usr)?\/bin\/(env\s+)?(dash|ash|sh)\b/.test(first)) return 'sh';
  if (/^#!/.test(first)) return 'bash';
  const t = String(text);
  if (/^\s*(\[CmdletBinding|param\s*\()|\b(Write-Host|Write-Output|Get-ChildItem|Set-Location|New-Item|Invoke-WebRequest)\b|\$env:\w|\$PSVersionTable|\$null\b/im.test(t)) return 'powershell';
  if (/^\s*(import \w|from [\w.]+ import |def \w+\(.*\):\s*$|if __name__ == ['"]__main__['"])/m.test(t)) return 'python';
  return 'bash';
}

// ---------------------------------------------------------------------------------------------
// PowerShell

/**
 * Returns the index just after the top-level param(...) block (after any [CmdletBinding()] etc.),
 * or the index after leading `using` lines when there is no param block. -1 if parsing fails.
 */
export function psInsertIndex(text) {
  let i = 0;
  const n = text.length;
  let afterUsing = 0;
  const skipSpace = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('<#', i)) {
        const end = text.indexOf('#>', i + 2);
        if (end < 0) return false;
        i = end + 2;
      } else if (text[i] === '#') {
        while (i < n && text[i] !== '\n') i++;
      } else return true;
    }
  };
  if (!skipSpace()) return -1;
  while (/^using\s/i.test(text.slice(i, i + 6))) {
    while (i < n && text[i] !== '\n') i++;
    afterUsing = i;
    if (!skipSpace()) return -1;
  }
  // Attributes such as [CmdletBinding()] or [OutputType([string])]
  while (text[i] === '[') {
    const end = matchClose(text, i, '[', ']');
    if (end < 0) return -1;
    i = end + 1;
    if (!skipSpace()) return -1;
  }
  if (/^param\s*\(/i.test(text.slice(i, i + 40))) {
    const open = text.indexOf('(', i);
    const end = matchClose(text, open, '(', ')');
    return end < 0 ? -1 : end + 1;
  }
  return afterUsing; // no param block: insert before any attributes
}

/** Matching close bracket, skipping quoted strings ('' and "" with ` escapes). */
function matchClose(text, at, open, close) {
  let depth = 0;
  let q = '';
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (q === "'") {
      if (c === "'") q = '';
    } else if (q === '"') {
      if (c === '`') i++;
      else if (c === '"') q = '';
    } else if (c === "'" || c === '"') q = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Drops comment and blank lines outside here-strings, block comments and multi-line strings. Keeps #Requires. */
export function compactPowerShell(text) {
  const src = text.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let here = ''; // closing token of an open here-string: "@ or '@
  let block = false; // inside <# ... #>
  let quote = '';
  let continued = false;
  for (const line of lines) {
    if (here) {
      out.push(line);
      if (line.startsWith(here)) here = '';
      continue;
    }
    if (block) {
      if (line.includes('#>')) {
        block = false;
        if (!/#>\s*$/.test(line)) return src; // code after the block comment: don't risk it
      }
      continue;
    }
    if (!quote && !continued) {
      if (/^\s*$/.test(line)) continue;
      if (/^\s*#requires\b/i.test(line)) {
        out.push(line);
        continue;
      }
      if (/^\s*<#/.test(line)) {
        if (/#>\s*$/.test(line)) continue;
        if (line.includes('#>')) return src;
        block = true;
        continue;
      }
      if (/^\s*#/.test(line)) continue;
    }
    out.push(line);
    let prev = ' ';
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (quote === "'") {
        if (c === "'") quote = '';
      } else if (quote === '"') {
        if (c === '`') j++;
        else if (c === '"') quote = '';
      } else if (c === '`') {
        j++;
      } else if ((c === '@') && (line[j + 1] === '"' || line[j + 1] === "'") && /^\s*$/.test(line.slice(j + 2))) {
        here = `${line[j + 1]}@`;
        break;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === '<' && line[j + 1] === '#') {
        return src; // inline block comment: leave the script as it is
      } else if (c === '#' && /[\s;({]/.test(prev)) {
        break;
      }
      prev = c;
    }
    continued = !quote && !here && /`$/.test(line);
  }
  if (here || block || quote) return src;
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Python

/** Index after the shebang/comments, module docstring and `from __future__` imports. */
export function pyInsertIndex(text) {
  const lines = text.split('\n');
  let i = 0;
  const skipComments = () => {
    while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
  };
  skipComments();
  const doc = /^\s*[rRuUbB]{0,2}("""|''')/.exec(lines[i] || '');
  if (doc) {
    const q = doc[1];
    const rest = lines[i].slice(lines[i].indexOf(q) + 3);
    if (rest.includes(q)) i++;
    else {
      i++;
      while (i < lines.length && !lines[i].includes(q)) i++;
      i++;
    }
    skipComments();
  }
  while (i < lines.length && /^\s*from\s+__future__\s+import\b/.test(lines[i])) {
    if (lines[i].includes('(') && !lines[i].includes(')')) {
      while (i < lines.length && !lines[i].includes(')')) i++;
    }
    i++;
    skipComments();
  }
  return lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
}

/** Drops comment and blank lines outside triple-quoted strings. */
export function compactPython(text) {
  const src = text.replace(/\r\n?/g, '\n');
  const out = [];
  let triple = '';
  src.split('\n').forEach((line, idx) => {
    if (triple) {
      out.push(line);
      if (count(line, triple) % 2 === 1) triple = '';
      return;
    }
    if (idx > 0 && /^\s*(#.*)?$/.test(line)) return;
    out.push(line);
    const code = stripPyStrings(line);
    for (const q of ['"""', "'''"]) if (count(code, q) % 2 === 1) triple = q;
  });
  if (triple) return src;
  return out.join('\n') + '\n';
}

const count = (s, sub) => s.split(sub).length - 1;
// Removes single-line '...' and "..." strings and trailing comments, leaving triple quotes visible.
const stripPyStrings = (line) => line.replace(/("""|''')|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m, t) => t || '""').replace(/#.*$/, '');
