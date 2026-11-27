// Flags lines that can do serious damage, so whoever copies the command looks twice.
// Warnings only: they never block.

const SHELL = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b[^\n#]*(\s\/(\s|\*|$)|\s~\/?(\s|$)|\s\/\*|\$\{?[A-Za-z_]\w*\b(?!:\?)\}?(?!\/?[A-Za-z0-9._-]))/, 'Recursive delete of a root, home or variable path. If the variable is empty, this deletes far more than intended (use ${VAR:?} to stop on empty).'],
  [/\bmkfs(\.\w+)?\b/, 'Formats a filesystem.'],
  [/\bdd\b[^\n#]*\bof=\/dev\//, 'Writes straight to a disk device.'],
  [/>\s*\/dev\/(sd[a-z]|nvme\d|xvd[a-z]|hd[a-z])/, 'Overwrites a disk device.'],
  [/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?0?777\b/, 'Makes files writable by everyone.'],
  [/\b(curl|wget)\b[^\n#]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'Downloads and runs another script that this page cannot show you.'],
  [/\biptables\s+(-F|--flush)\b|\bnft\s+flush\s+ruleset\b|\bufw\s+disable\b/, 'Flushes or disables the firewall.'],
  [/\b(userdel|deluser)\b/, 'Deletes a user account.'],
  [/\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/, 'Shuts down or restarts the machine.'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'Fork bomb: makes the machine unresponsive.'],
  [/\bsystemctl\s+(stop|disable|mask)\s+(sshd?|networking|NetworkManager)\b/, 'Stops SSH or networking: you may lose access.'],
  [/\b(kubectl|helm)\s+(delete|uninstall)\b/, 'Deletes Kubernetes resources.'],
  [/\bDROP\s+(DATABASE|TABLE)\b|\bTRUNCATE\s+TABLE\b/i, 'Drops or truncates database data.'],
];

const POWERSHELL = [
  [/\bRemove-Item\b[^\n#]*-Recurse\b/i, 'Recursive delete. Check the path, especially if it comes from a variable.'],
  [/\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, 'Formats or wipes a disk.'],
  [/\b(Stop-Computer|Restart-Computer)\b/i, 'Shuts down or restarts the machine.'],
  [/\b(Invoke-Expression|iex)\b[^\n#]*\b(Invoke-WebRequest|iwr|Invoke-RestMethod|irm|DownloadString)\b|\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n#]*\|\s*(iex|Invoke-Expression)\b/i, 'Downloads and runs another script that this page cannot show you.'],
  [/\bSet-ExecutionPolicy\b[^\n#]*\b(Unrestricted|Bypass)\b/i, 'Loosens the execution policy for the machine.'],
  [/\bSet-NetFirewallProfile\b[^\n#]*-Enabled\s+(False|\$false)|\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i, 'Turns off the firewall.'],
  [/\b(Remove-LocalUser|Remove-ADUser)\b/i, 'Deletes a user account.'],
  [/\bStop-Service\b[^\n#]*\b(WinRM|sshd|TermService)\b/i, 'Stops remote access: you may lose the connection.'],
  [/\bRemove-Item\b[^\n#]*HK(LM|CU):/i, 'Deletes registry keys.'],
];

const PYTHON = [
  [/\bshutil\.rmtree\(/, 'Deletes a directory tree. Check the path.'],
  [/\bsubprocess\.\w+\([^)]*shell\s*=\s*True/, 'Runs a shell command built from a string (shell=True).'],
  [/\bos\.(system|popen)\(/, 'Runs a shell command.'],
];

const TABLE = { bash: SHELL, sh: SHELL, powershell: POWERSHELL, python: [...PYTHON, ...SHELL] };

/** @returns {{line: number, label: string, code: string}[]} one entry per line and rule */
export function findDangers(text, lang = 'bash') {
  const rules = TABLE[lang] || SHELL;
  const out = [];
  const shell = lang === 'bash' || lang === 'sh';
  let heredoc = '';
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    // Heredoc bodies are text (help, config, files being written), not commands that run here.
    if (heredoc) {
      if (raw.replace(/^\t+/, '').trim() === heredoc) heredoc = '';
      return;
    }
    const h = shell && /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(raw.replace(/<<</g, ''));
    if (h) heredoc = h[2];
    const line = raw.replace(/^\s*#.*$/, '');
    if (!line.trim()) return;
    for (const [re, label] of rules) if (re.test(line)) out.push({ line: i + 1, label, code: raw.trim().slice(0, 120) });
  });
  return out;
}
