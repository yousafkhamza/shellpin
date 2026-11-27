// Reads a shell script and works out what arguments it takes, so the page can ask only for those.
// Heuristic, not a shell parser. Sources, strongest first:
//   1. usage text:        "Usage: $0 create|delete <user> [--hours N]"   (labels, required/optional, choices)
//   2. case statements:   case "$ACTION" in create) ... delete) ...      (choices)
//   3. assignments:       USER="$2", PORT="${3:-8080}"                    (names, defaults)
//   4. option loops:      while ...; case "$1" in --hours) ... shift 2    (flags; value if $2/shift 2/OPTARG)
//      getopts ":ab:c"                                                   (flags; ':' means it takes a value)
//   5. env settings:      ${PEM_LINK_HOURS:-24} for a variable the script never sets itself
//   6. examples:          echo "  $0 create admin both yes yes",  "... | bash -s -- file --hours 2"
//   7. prompts:           read -r -p "Enter choice (1/2/3): "

const SHELL_VARS = new Set(['HOME', 'PATH', 'USER', 'SHELL', 'TERM', 'PWD', 'OLDPWD', 'HOSTNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'UID', 'EUID', 'IFS', 'BASH_SOURCE', 'BASH_VERSION', 'LOGNAME', 'EDITOR', 'PAGER', 'SUDO_USER', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DEBIAN_FRONTEND', 'OSTYPE', 'RANDOM', 'LINENO', 'SECONDS', 'OPTARG', 'OPTIND', 'PS1', 'PS4']);
const PROG = String.raw`(?:"?\$0"?|"?\$\{0\}"?|"?\$\{0##\*/\}"?|"?\$\(basename\s+"?\$\{?0\}?"?\)"?|"?\$\{?(?:SCRIPT_NAME|SCRIPT|PROG|PROGNAME|ME|SELF)\}?"?)`;
const PROG_RE = new RegExp(`${PROG}\\s+(.*)$`);
const HELP = new Set(['-h', '--help', '-?', '--version', '-v', '-V']);

const humanize = (v) => v.toLowerCase().replace(/_/g, ' ');
const stripQuotes = (s) => s.replace(/^["']|["']$/g, '');

/** Picks the most readable spelling from "1|pem" or "y|yes". */
function bestAlt(item) {
  const alts = item.split('|').map((a) => stripQuotes(a.trim())).filter(Boolean);
  if (!alts.length || alts.some((a) => /[*?[\]$`\\(){}]/.test(a) || /\s/.test(a))) return null;
  const words = alts.filter((a) => /[A-Za-z]/.test(a));
  const pool = words.length ? words : alts;
  return pool.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Splits a script into lines of code, without comments, heredoc bodies or single-quoted text. */
function codeLines(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let heredoc = null;
  for (const line of raw) {
    if (heredoc) {
      if (line.replace(/^\t+/, '').trim() === heredoc) heredoc = null;
      out.push({ code: '', raw: line, inHeredoc: true });
      continue;
    }
    const h = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (h) heredoc = h[2];
    let code = /^\s*#/.test(line) ? '' : line.replace(/(^|\s)#.*$/, '$1');
    code = code.replace(/'[^'\n]*'/g, "''").replace(/\\\$/g, '');
    out.push({ code, raw: line, inHeredoc: false });
  }
  return out;
}

/** Marks lines inside functions (their $1 is the function's own argument) unless called with "$@". */
function markFunctions(lines, text) {
  const forwarded = new Set([...text.matchAll(/(?:^|[\s;&|])([A-Za-z_][\w-]*)\s+"\$@"/gm)].map((m) => m[1]));
  let depth = 0;
  let inFn = false;
  let fnForwarded = false;
  for (const l of lines) {
    const start = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{?/.exec(l.code) || /^\s*function\s+([A-Za-z_][\w-]*)\s*\{?/.exec(l.code);
    if (!inFn && start) {
      inFn = true;
      fnForwarded = forwarded.has(start[1]);
      depth = 0;
    }
    l.inFunction = inFn && !fnForwarded;
    if (inFn) {
      const opens = (l.code.match(/\{/g) || []).length;
      const closes = (l.code.match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth <= 0 && (opens || closes)) inFn = false;
    }
  }
}

/** Finds case blocks: subject ("$1", "$ACTION", "$opt") and items with their body text. */
function caseBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /\bcase\s+"?\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9])\}?"?\s+in\b/.exec(lines[i].code);
    if (!m) continue;
    const block = { subject: m[1], start: i, items: [], inFunction: lines[i].inFunction };
    let depth = 1;
    let cur = null;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      const code = lines[j].code;
      if (/\bcase\b.*\bin\b/.test(code)) depth++;
      if (/(^|[\s;])esac\b/.test(code)) {
        depth--;
        if (depth === 0) {
          block.end = j;
          break;
        }
      }
      const it = depth === 1 && /^\s*\(?\s*([^()\s][^()]*?)\s*\)(.*)$/.exec(code);
      if (it && !/^\s*(if|then|else|fi|do|done|echo|printf|local|for|while)\b/.test(code) && !/[=]/.test(it[1])) {
        cur = { pattern: it[1].trim(), body: it[2] };
        block.items.push(cur);
      } else if (cur) {
        cur.body += `\n${code}`;
      }
    }
    block.end ??= lines.length - 1;
    blocks.push(block);
  }
  return blocks;
}

/** Tokenises usage text: [opt|ional], <named>, "quoted", words. */
function usageTokens(s) {
  return (s.match(/\[[^\]]*\]|<[^>]*>|"[^"]*"|\S+/g) || []).filter((t) => t !== '\\');
}

function parseUsage(usage) {
  const positional = [];
  const options = [];
  for (const tok of usageTokens(usage)) {
    const optional = tok.startsWith('[');
    const inner = optional ? tok.slice(1, -1).trim() : tok;
    if (/^-/.test(inner)) {
      const [flags, ...rest] = inner.split(/\s+/);
      const names = flags.split('|');
      if (!names.some((n) => HELP.has(n))) {
        options.push({ flag: names.find((n) => n.startsWith('--')) || names[0], aliases: names, takesValue: rest.length > 0, label: rest.join(' ').replace(/[<>]/g, '') });
      }
      continue;
    }
    if (/^[\w$/{}.:-]*$/.test(inner) && /^\$|^\.{3}$/.test(inner)) continue;
    const variadic = /\.\.\.$/.test(inner);
    const core = inner.replace(/\.\.\.$/, '').trim();
    const named = /^<([^>]+)>$/.exec(core);
    const choices = !named && core.includes('|') ? core.split('|').map((c) => c.trim()).filter((c) => c && !/[<>]/.test(c)) : [];
    positional.push({
      label: named ? named[1] : choices.length ? '' : core.replace(/[<>]/g, ''),
      required: !optional,
      choices,
      variadic,
    });
  }
  return { positional, options };
}

function findUsageAndExamples(text, lines) {
  let usage = '';
  const examples = [];
  const meta = /^#\s*@usage\s+(.+)$/m.exec(text);
  if (meta) usage = meta[1].trim();

  const all = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    // Literal "Usage: name.sh args" (heredocs, echo).
    const lit = /usage:\s*(\S+)\s+(.*?)\s*["']?\s*$/i.exec(line);
    let rest = null;
    if (lit && !/^\$|^\(|^\$\{/.test(lit[1]) && !/^["']?$/.test(lit[2])) rest = lit[2];
    const prog = PROG_RE.exec(line);
    if (prog) rest = prog[1];
    if (rest === null) {
      const piped = /\|\s*(?:sudo\s+)?bash\s+-s\s+--\s+(.+?)\s*["']?\s*$/.exec(line);
      if (piped && !/[<[]/.test(piped[1])) examples.push(piped[1]);
      continue;
    }
    // echo "usage: $0 ..."; exit 1  ->  stop at the quote that closes the echo
    const q = /(?:\becho(?:\s+-[a-zA-Z]+)?|\bprintf)\s+(["'])/.exec(line)?.[1];
    if (q) rest = rest.split(q)[0];
    rest = rest.replace(/["']\s*;?\s*$/, '').replace(/\\n.*$/, '').trim();
    if (!rest || /^>/.test(rest)) continue;
    if (/[<[|]|\.\.\./.test(rest)) {
      if (!usage) usage = rest;
    } else if (/usage/i.test(line) && !usage) {
      usage = rest;
    } else if (!/^\$/.test(rest)) {
      examples.push(rest);
    }
  }
  return { usage, examples: [...new Set(examples)].slice(0, 8) };
}

/** Sample value for an argument, from its name. */
export function sampleFor(label = '', choices = [], dflt = '') {
  if (choices.length) return choices[0];
  if (dflt && !/[$`]/.test(dflt)) return dflt;
  const l = label.toLowerCase();
  const table = [
    [/user ?name|^user$|login|account/, 'alice'],
    [/e-?mail/, 'ops@example.com'],
    [/host|server|ip|addr/, '10.0.0.5'],
    [/port/, '8080'],
    [/url|endpoint/, 'https://example.com'],
    [/domain/, 'example.com'],
    [/region/, 'ap-south-1'],
    [/env(ironment)?$|stage/, 'staging'],
    [/branch/, 'main'],
    [/version|tag/, '1.0.0'],
    [/dir|folder/, '/tmp/work'],
    [/file|path|config|key/, './file.txt'],
    [/hours?/, '24'],
    [/days?/, '7'],
    [/count|num|^n$|size|limit|max|min|retries|timeout|seconds?|minutes?/, '3'],
    [/pass|secret|token/, '…'],
    [/namespace|^ns$/, 'default'],
    [/name|service|app|project|cluster|deploy/, 'demo'],
    [/yes|enable|sudo|sftp|force|confirm/, 'yes'],
  ];
  for (const [re, v] of table) if (re.test(l)) return v;
  return 'value';
}

/**
 * @returns {{
 *   positional: {index:number, name:string, label:string, required:boolean, choices:string[], default:string, sample:string, variadic:boolean}[],
 *   options: {flag:string, aliases:string[], takesValue:boolean, label:string, sample:string}[],
 *   env: {name:string, default:string}[],
 *   examples: string[], prompts: string[], usage: string, hasArgs: boolean, takesAny: boolean
 * }}
 */
function scanShell(text) {
  const lines = codeLines(text);
  markFunctions(lines, text);
  const blocks = caseBlocks(lines);

  // Option-parsing loops: case on $1 (or a getopts variable) with items like --hours) / -n)
  const optionBlocks = blocks.filter((b) => (b.subject === '1' || /^(opt|o|flag|arg|option|c)$/i.test(b.subject)) && b.items.some((it) => /^-/.test(it.pattern) || /^[a-zA-Z]$/.test(it.pattern)) && !b.inFunction);
  const insideOptionBlock = (i) => optionBlocks.some((b) => i > b.start && i <= b.end);

  const options = [];
  const operandNames = [];
  const getopts = /\bgetopts\s+["']?:?([A-Za-z0-9:]+)["']?\s+(\w+)/.exec(text);
  for (const b of optionBlocks) {
    for (const it of b.items) {
      const pats = it.pattern.split('|').map((p) => stripQuotes(p.trim()));
      if (pats.includes('*') || pats.includes('-*')) {
        const op = /([A-Za-z_]\w*)=["']?\$\{?1\}?/.exec(it.body);
        if (op && pats.includes('*')) operandNames.push(op[1]);
        continue;
      }
      if (pats.some((p) => HELP.has(p) || p === 'h' || p === '?' || p === '\\?' || p === ':' || p === '--')) continue;
      const flags = getopts && b.subject === getopts[2] ? pats.map((p) => `-${p}`) : pats.filter((p) => /^-/.test(p));
      if (!flags.length) continue;
      const takesValue = /\$\{?2\b|\bshift\s+2\b|\$\{?OPTARG\}?/.test(it.body);
      const valueVar = /([A-Za-z_]\w*)=["']?\$\{?(?:2|OPTARG)\b/.exec(it.body)?.[1] || '';
      options.push({ flag: flags.find((f) => f.startsWith('--')) || flags[0], aliases: flags, takesValue, label: valueVar ? humanize(valueVar) : '', sample: '' });
    }
  }
  if (getopts && !optionBlocks.length) {
    for (const m of getopts[1].matchAll(/([A-Za-z0-9])(:?)/g)) if (m[1] !== 'h') options.push({ flag: `-${m[1]}`, aliases: [`-${m[1]}`], takesValue: !!m[2], label: '', sample: '' });
  }

  // Positional assignments and references at script level.
  const byIndex = new Map();
  let usesAll = false;
  lines.forEach((l, i) => {
    if (l.inFunction || l.inHeredoc || insideOptionBlock(i)) return;
    for (const m of l.code.matchAll(/(?:^|[\s;(])(?:local\s+|readonly\s+|export\s+|declare\s+\S*\s*)?([A-Za-z_]\w*)=["']?\$\{?([1-9])(?:(:?[-=])([^}"']*))?\}?/g)) {
      const idx = Number(m[2]);
      if (!byIndex.has(idx)) byIndex.set(idx, { name: m[1], default: m[4] || '' });
    }
    for (const m of l.code.matchAll(/\$\{?([1-9])(?:(:?[-=])([^}]*))?\}?/g)) {
      const idx = Number(m[1]);
      if (!byIndex.has(idx)) byIndex.set(idx, { name: '', default: m[3] || '' });
      else if (m[3] && !byIndex.get(idx).default) byIndex.get(idx).default = m[3];
    }
    if (/"\$@"|\$\*|"\$\{@\}"/.test(l.code) && !/\bshift\b/.test(l.code)) usesAll = true;
  });
  // Operands collected in an option loop count as positional 1..n.
  operandNames.forEach((name, k) => {
    if (!byIndex.has(k + 1)) byIndex.set(k + 1, { name, default: '' });
  });

  const { usage, examples } = findUsageAndExamples(text, lines);
  const fromUsage = parseUsage(usage);

  // Choices from case statements on a positional variable.
  const choicesFor = (idx, name) => {
    const b = blocks.find((x) => !optionBlocks.includes(x) && (x.subject === String(idx) || (name && x.subject === name)));
    if (!b) return [];
    const out = [];
    for (const it of b.items) {
      const v = bestAlt(it.pattern);
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  };

  const count = Math.max(fromUsage.positional.length, ...[...byIndex.keys()], 0);
  const positional = [];
  for (let idx = 1; idx <= Math.min(count, 9); idx++) {
    const code = byIndex.get(idx) || { name: '', default: '' };
    const u = fromUsage.positional[idx - 1];
    const caseChoices = choicesFor(idx, code.name);
    const choices = u?.choices.length ? u.choices : caseChoices;
    const label = (u?.label || (code.name ? humanize(code.name) : '') || `argument ${idx}`).trim();
    const required = u ? u.required : !code.default && !operandNames.length ? idx === 1 || !!code.name : false;
    positional.push({ index: idx, name: code.name, label, required: required && !code.default, choices, default: code.default, sample: sampleFor(label, choices, code.default), variadic: !!u?.variadic });
  }

  // Merge usage-declared options with code-detected ones.
  for (const o of fromUsage.options) {
    const hit = options.find((x) => x.aliases.some((a) => o.aliases.includes(a)));
    if (hit) {
      hit.takesValue ||= o.takesValue;
      if (o.label) hit.label = o.label;
    } else options.push({ ...o, sample: '' });
  }
  for (const o of options) o.sample = o.takesValue ? sampleFor(`${o.flag.replace(/^-+/, '')} ${o.label}`.trim()) : '';

  // Settings read from the environment: ${VAR:-x} for a VAR the script never assigns (except VAR=${VAR:-...}).
  const env = [];
  const seen = new Set(positional.map((p) => p.name).filter(Boolean));
  const codeText = lines.map((l) => l.code).join('\n');
  for (const m of codeText.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):?[-=]([^}]*)\}/g)) {
    const name = m[1];
    if (SHELL_VARS.has(name) || seen.has(name)) continue;
    const assigns = [...codeText.matchAll(new RegExp(`(?:^|[\\s;(])(?:local\\s+|export\\s+|readonly\\s+|declare\\s+\\S*\\s*)?${name}=(.*)$`, 'gm'))];
    if (assigns.some((a) => !a[1].replace(/^["']/, '').startsWith(`\${${name}`))) continue;
    seen.add(name);
    env.push({ name, default: /[$`]/.test(m[2]) ? '' : m[2] });
  }
  // Plain $VAR / ${VAR} the script reads but never sets (skipped when it sources other files, which may set them).
  if (!/^\s*(\.|source)\s+\S/m.test(codeText)) {
    for (const m of codeText.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = m[1];
      if (SHELL_VARS.has(name) || seen.has(name) || /^(BASH_\w+|FUNCNAME|PIPESTATUS|GROUPS|PPID|SHLVL|COLUMNS|LINES|HISTFILE|MAIL\w*|DISPLAY|SSH_\w+)$/.test(name)) continue;
      const set = new RegExp(`(?:^|[\\s;(])(?:local\\s+|export\\s+|readonly\\s+|declare\\s+\\S*\\s*)?${name}(\\[[^\\]]*\\])?\\+?=|\\bread\\b[^\\n;|&]*\\b${name}\\b|\\bfor\\s+${name}\\s+in\\b|\\bgetopts\\s+\\S+\\s+${name}\\b|\\bmapfile\\b[^\\n;]*\\b${name}\\b`, 'm');
      if (set.test(codeText)) continue;
      seen.add(name);
      env.push({ name, default: '' });
    }
  }

  const prompts = [...text.matchAll(/\bread\b[^\n]*?-p\s+(?:"([^"]*)"|'([^']*)')/g)].map((m) => (m[1] ?? m[2]).trim()).filter(Boolean);

  if (!positional.length && usesAll) positional.push({ index: 1, name: '', label: 'arguments', required: false, choices: [], default: '', sample: 'value', variadic: true });

  return {
    positional,
    options,
    env,
    examples,
    prompts: [...new Set(prompts)],
    usage,
    hasArgs: positional.length > 0 || options.length > 0,
    takesAny: usesAll,
  };
}

/** Quotes a value for bash only when it needs it. */
export function shq(v) {
  const s = String(v);
  return /^[A-Za-z0-9@%+=:,./_~^-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Splits an example argument string into words (handles simple quotes). */
export function splitArgs(s) {
  const out = [];
  for (const m of String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Turns form values into an argument string. Empty optional positionals before a filled one become ''.
 * @param {{positional: string[], options: Record<string, string|boolean>, extra?: string}} v
 */
export function buildArgs(scan, v) {
  if (scan.lang === 'powershell') return buildPsArgs(scan, v);
  const parts = [];
  for (const o of scan.options) {
    const val = v.options?.[o.flag];
    if (o.takesValue ? val : val === true) parts.push(o.takesValue ? `${o.flag} ${shq(val)}` : o.flag);
  }
  const pos = (v.positional || []).slice(0, scan.positional.length);
  let last = pos.length - 1;
  while (last >= 0 && !pos[last]) last--;
  const posParts = [];
  for (let i = 0; i <= last; i++) posParts.push(pos[i] ? (scan.positional[i]?.variadic ? pos[i] : shq(pos[i])) : "''");
  // Operands first, then flags, matches most scripts' usage lines; flags first is also accepted by option loops.
  const all = [...posParts, ...parts];
  if (v.extra?.trim()) all.push(v.extra.trim());
  return all.join(' ');
}

/** Maps an example string onto form values. */
export function fillFromExample(scan, example) {
  if (scan.lang === 'powershell') return fillPsExample(scan, example);
  const words = splitArgs(example);
  const positional = [];
  const options = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const opt = scan.options.find((o) => o.aliases.includes(w) || o.aliases.some((a) => w.startsWith(`${a}=`)));
    if (opt) {
      if (opt.takesValue) options[opt.flag] = w.includes('=') ? w.slice(w.indexOf('=') + 1) : words[++i] ?? '';
      else options[opt.flag] = true;
    } else positional.push(w);
  }
  const extra = positional.length > scan.positional.length && !scan.positional.at(-1)?.variadic ? positional.splice(scan.positional.length).map(shq).join(' ') : '';
  if (scan.positional.at(-1)?.variadic && positional.length > scan.positional.length) {
    const n = scan.positional.length;
    positional.splice(n - 1, positional.length, positional.slice(n - 1).map(shq).join(' '));
  }
  return { positional, options, extra };
}

// =============================================================================================
// Other languages. Every scanner returns the same shape, plus `lang`.

/** @param {'bash'|'sh'|'powershell'|'python'} lang */
export function scanArgs(text, lang = 'bash') {
  const t = String(text).replace(/\r\n?/g, '\n');
  if (lang === 'powershell') return { ...scanPowerShell(t), lang };
  if (lang === 'python') return { ...scanPython(t), lang };
  return { ...scanShell(t), lang };
}

/** Quotes a PowerShell argument only when needed ('' doubles a quote). */
export function psq(v) {
  const s = String(v);
  return /^[A-Za-z0-9_.:/\\+=~-]+$/.test(s) && !s.startsWith('-') ? s : `'${s.replace(/'/g, "''")}'`;
}

/** Splits text at top-level commas (outside (), [], {}, quotes). */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '`' && q === '"') cur += s[i++];
    } else if (c === "'" || c === '"') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const unq = (s) => String(s).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
const literals = (s) => [...String(s).matchAll(/'((?:[^']|'')*)'|"((?:[^"`]|`.)*)"/g)].map((m) => (m[1] ?? m[2]).replace(/''/g, "'"));

function scanPowerShell(text) {
  const positional = [];
  const options = [];
  const noComments = text.replace(/<#[\s\S]*?#>/g, '').replace(/(^|\s)#(?!requires).*$/gim, '$1');
  const m = /^\s*(?:\[[\s\S]*?\]\s*)*param\s*\(/im.exec(noComments);
  if (m) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    let q = '';
    for (let i = open; i < noComments.length; i++) {
      const c = noComments[i];
      if (q) {
        if (c === q) q = '';
      } else if (c === "'" || c === '"') q = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    const body = end > 0 ? noComments.slice(open + 1, end) : '';
    const params = splitTop(body).map((chunk) => {
      const name = /\$([A-Za-z_]\w*)\s*(=|$)/m.exec(chunk) || /\$([A-Za-z_]\w*)/.exec(chunk);
      if (!name) return null;
      const attrs = chunk.slice(0, name.index);
      const dflt = /\$[A-Za-z_]\w*\s*=\s*([\s\S]+)$/.exec(chunk)?.[1]?.trim() || '';
      const paramAttr = /\[Parameter\s*\(([\s\S]*?)\)\s*\]/i.exec(attrs)?.[1] || '';
      return {
        name: name[1],
        type: /\[(switch|string|int|int32|int64|bool|double|datetime|string\[\]|securestring|pscredential)\]/i.exec(attrs)?.[1]?.toLowerCase() || '',
        required: /\bMandatory\b(?!\s*=\s*\$false)/i.test(paramAttr),
        help: unq(/\bHelpMessage\s*=\s*('[^']*'|"[^"]*")/i.exec(paramAttr)?.[1] || ''),
        choices: literals(/\[ValidateSet\s*\(([\s\S]*?)\)\s*\]/i.exec(attrs)?.[1] || ''),
        default: /^\$(true|false|null)$/i.test(dflt) || /[$(]/.test(dflt) ? '' : unq(dflt),
      };
    }).filter(Boolean);
    let idx = 0;
    for (const p of params) {
      if (p.type === 'switch') {
        options.push({ flag: `-${p.name}`, aliases: [`-${p.name}`], takesValue: false, label: p.help, sample: '' });
        continue;
      }
      idx++;
      positional.push({
        index: idx,
        name: p.name,
        label: p.name,
        required: p.required,
        choices: p.choices,
        default: p.default,
        sample: sampleFor(p.name, p.choices, p.default),
        variadic: false,
        flag: `-${p.name}`,
        help: p.help,
        type: p.type,
        secret: p.type === 'securestring' || p.type === 'pscredential',
      });
    }
  }

  // Comment-based help examples: the line after .EXAMPLE, minus the prompt and the script name.
  const examples = [];
  for (const ex of text.matchAll(/^\s*\.EXAMPLE\s*\n\s*(?:PS\s*[^>\n]*>\s*)?(.+)$/gim)) {
    const line = ex[1].trim().replace(/^&\s*/, '').replace(/^(\.[\\/])?[\w.\\/-]+\.ps1\b\s*/i, '');
    if (line) examples.push(line);
  }

  const env = [];
  const assigned = new Set([...text.matchAll(/\$env:([A-Za-z_]\w*)\s*=(?!=)/gi)].map((x) => x[1].toUpperCase()));
  for (const e of text.matchAll(/\$env:([A-Za-z_]\w*)/gi)) {
    const name = e[1];
    if (assigned.has(name.toUpperCase()) || SHELL_VARS.has(name.toUpperCase()) || /^(USERNAME|USERPROFILE|COMPUTERNAME|TEMP|TMP|APPDATA|LOCALAPPDATA|PROGRAMFILES|SYSTEMROOT|WINDIR|PSMODULEPATH|SHELLPIN_S)$/i.test(name)) continue;
    if (!env.some((x) => x.name.toUpperCase() === name.toUpperCase())) env.push({ name, default: '' });
  }
  const prompts = [...text.matchAll(/\bRead-Host\b\s+(?:-Prompt\s+)?(['"])(.*?)\1/gi)].map((x) => x[2]);
  return { positional, options, env, examples: [...new Set(examples)].slice(0, 8), prompts: [...new Set(prompts)], usage: '', hasArgs: positional.length + options.length > 0, takesAny: false };
}

function buildPsArgs(scan, v) {
  const parts = [];
  scan.positional.forEach((p, i) => {
    const val = v.positional?.[i];
    if (val) parts.push(`${p.flag || ''} ${psq(val)}`.trim());
  });
  for (const o of scan.options) if (v.options?.[o.flag] === true) parts.push(o.flag);
  if (v.extra?.trim()) parts.push(v.extra.trim());
  return parts.join(' ');
}

function fillPsExample(scan, example) {
  const words = splitArgs(example);
  const positional = scan.positional.map(() => '');
  const options = {};
  const loose = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^-\w/.test(w)) {
      const name = w.slice(1).replace(/:.*$/, '').toLowerCase();
      const pi = scan.positional.findIndex((p) => p.name.toLowerCase() === name);
      const oi = scan.options.findIndex((o) => o.flag.slice(1).toLowerCase() === name);
      if (pi >= 0) positional[pi] = w.includes(':') ? w.slice(w.indexOf(':') + 1) : words[++i] ?? '';
      else if (oi >= 0) options[scan.options[oi].flag] = true;
      else loose.push(w);
    } else loose.push(w);
  }
  // Unnamed values fill the remaining parameters in order.
  while (loose.length && !/^-/.test(loose[0])) {
    const free = positional.findIndex((x) => !x);
    if (free < 0) break;
    positional[free] = loose.shift();
  }
  return { positional, options, extra: loose.map(psq).join(' ') };
}

function scanPython(text) {
  const positional = [];
  const options = [];
  const calls = [];
  for (const m of text.matchAll(/\badd_argument\s*\(/g)) {
    let depth = 0;
    let q = '';
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = '';
      } else if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end > 0) calls.push(text.slice(m.index + m[0].length, end));
  }
  for (const call of calls) {
    const parts = splitTop(call);
    const names = parts.filter((p) => /^\s*['"]/.test(p)).map(unq);
    const kw = Object.fromEntries(parts.filter((p) => /^\s*\w+\s*=/.test(p)).map((p) => [p.split('=')[0].trim(), p.slice(p.indexOf('=') + 1).trim()]));
    if (!names.length) continue;
    const choices = kw.choices ? (literals(kw.choices).length ? literals(kw.choices) : [...kw.choices.matchAll(/-?\d+(\.\d+)?/g)].map((x) => x[0])) : [];
    const dflt = kw.default && !/^(None|True|False)$/.test(kw.default) ? unq(kw.default) : '';
    const help = kw.help ? unq(kw.help) : '';
    if (names[0].startsWith('-')) {
      const action = kw.action ? unq(kw.action) : '';
      const flag = names.find((n) => n.startsWith('--')) || names[0];
      if (action === 'help' || action === 'version' || flag === '--help') continue;
      const takesValue = !/^(store_true|store_false|store_const|count)$/.test(action);
      options.push({ flag, aliases: names, takesValue, label: kw.metavar ? unq(kw.metavar) : '', sample: takesValue ? sampleFor(`${flag.replace(/^-+/, '')} ${help}`, choices, dflt) : '', choices, default: dflt });
    } else {
      const nargs = kw.nargs ? unq(kw.nargs) : '';
      positional.push({ index: positional.length + 1, name: names[0], label: names[0].replace(/_/g, ' '), required: !/^[?*]$/.test(nargs) && !dflt, choices, default: dflt, sample: sampleFor(names[0], choices, dflt), variadic: /^[*+]$/.test(nargs), help });
    }
  }
  if (!calls.length) {
    const named = new Map([...text.matchAll(/(\w+)\s*=\s*sys\.argv\[(\d)\]/g)].map((m) => [Number(m[2]), m[1]]));
    const max = Math.max(0, ...[...text.matchAll(/sys\.argv\[(\d)\]/g)].map((m) => Number(m[1])));
    for (let i = 1; i <= max; i++) positional.push({ index: i, name: named.get(i) || '', label: (named.get(i) || `argument ${i}`).replace(/_/g, ' '), required: true, choices: [], default: '', sample: sampleFor(named.get(i) || ''), variadic: false });
    if (!max && /sys\.argv\[1:\]/.test(text)) positional.push({ index: 1, name: '', label: 'arguments', required: false, choices: [], default: '', sample: 'value', variadic: true });
  }
  const env = [];
  for (const m of text.matchAll(/os\.(?:environ\.get|getenv)\(\s*['"](\w+)['"]\s*(?:,\s*['"]([^'"]*)['"])?|os\.environ\[\s*['"](\w+)['"]\s*\]/g)) {
    const name = m[1] || m[3];
    if (!env.some((e) => e.name === name) && !SHELL_VARS.has(name)) env.push({ name, default: m[2] || '' });
  }
  const prompts = [...text.matchAll(/\b(?:input|getpass(?:\.getpass)?)\(\s*(['"])(.*?)\1/g)].map((m) => m[2]);
  const usage = /\busage\s*=\s*(['"])(.*?)\1/.exec(text)?.[2]?.replace(/%\(prog\)s\s*/, '') || '';
  return { positional, options, env, examples: [], prompts: [...new Set(prompts)], usage, hasArgs: positional.length + options.length > 0, takesAny: false };
}
