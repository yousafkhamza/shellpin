# shellpin

Paste a shell script, get one command that runs it on any server. Nothing is uploaded or stored, and the command stops working after the time you pick (one year at most).

**https://yousafkhamza.github.io/shellpin/**

1. Paste the script (or drop a `.sh` file), set the arguments, tick sudo if needed, and choose how long the command should work.
2. Copy the command and paste it into the server:

```bash
s="$(base64 -d <<'SHELLPIN' | gunzip
H4sIAAAAAAAAA41WbW/bNhD+7l9x1YIiwSZZTpdtNZAPWZqi...
SHELLPIN
)" && sudo bash -c "$s" userctl create jatin
```

How it works:
- **Asks only for the arguments the script takes.** The page reads the script and builds fields for:
  - positional arguments (`ACTION="$1"`, `${2:-8080}`), with names, defaults and choices taken from the usage text (`create|reset|delete <username> [yes|no]`) and from `case` statements;
  - flags from `getopts` or `--option` loops;
  - settings read from environment variables (`${PEM_LINK_HOURS:-24}`), passed as `VAR=value` after `sudo`.

  The script's own examples become one-click fills, a sample argument line is filled in for you, and `read -p` prompts are listed. A script with no arguments gets no fields.
- **Compact (on by default).** Comment lines and blank lines are dropped before compressing, which makes `userctl.sh`'s command 22% shorter. Heredoc bodies, multi-line strings and lines after a `\` continuation are kept, and tests check that bash prints exactly the same output with and without it.
- **No storage, no network.** The page gzips the script and base64-encodes it into the command. The page's Content-Security-Policy is `connect-src 'none'`, so the script never leaves the browser. The server needs no internet access and no TLS (no `curl` error 60), and no script file is left on disk.
- **Safe to paste.** The whole script is decoded before anything runs. A cut-short or damaged paste fails `gunzip`'s checksum, and nothing runs.
- **Interactive scripts work.** The script runs with the terminal as its input, so `read`, `Read-Host` and `input()` prompts work, and the name you give becomes `$0` (or `argv[0]`).
- **Expiry.** A guard line at the top of the script refuses to run after the chosen time. It stops old commands being reused, but it isn't a lock: anyone can decode the command by hand.
- **Share link.** "Copy share link" puts the script and settings into the part of the URL after `#`, so a colleague opens the same command. Nothing is stored here either.
- **Size.** Scripts can be up to 120 KB. A 12 KB script makes a command of about 5 KB, which pastes fine into any SSH terminal. A single-line mode is there for tools that can't paste multiple lines.

The command, and the script inside it, ends up in the server's shell history. Don't put secrets in scripts; use "ask on server" (below) instead.

### Languages

The language is detected from the file name, the shebang or the content, and you can change it.

| Language | Command runs it with | Arguments detected from |
|---|---|---|
| Bash | `bash -c "$s" name args` | usage text, `case`, `$1`…, `getopts`, `--option` loops |
| sh (POSIX, Alpine, BusyBox) | `sh -c "$s" name args` | same as Bash |
| PowerShell (5.1 and 7) | a decoded `[scriptblock]`, in a new PowerShell process by default | `param()`: `[ValidateSet]` becomes a dropdown, `[switch]` a checkbox, `Mandatory` marks a field required, `.EXAMPLE` lines become examples |
| Python 3 | `python3 -c "$s" args` (with `argv[0]` set to the name) | `argparse` (`choices`, `default`, `required`, `nargs`, `store_true`) or `sys.argv[n]` |

PowerShell runs in a new process by default, so an `exit` in the script doesn't close your window. Very large scripts (over about 22 KB compressed) run in the current window instead, because Windows limits the size of one environment variable. The PowerShell version of "sudo" is **Require administrator**, which stops with a clear message unless the window was opened with "Run as administrator".

### Where it runs

| Run on | Command |
|---|---|
| The machine you paste into | as above |
| A Kubernetes pod | `kubectl exec -it POD -n NS [-c CONTAINER] -- sh -c "$s" …`. Decoded on your machine, so the container needs only the interpreter. |
| A Docker container | `docker exec -it [-u root] CONTAINER sh -c "$s" …` |
| Servers over SSH | `ssh -t host '…'`, or a loop over several hosts with a `== host` header for each |

### Safety

- **Danger warnings.** Before you copy, the page flags lines such as `rm -rf "$VAR"`, `mkfs`, `dd of=/dev/…`, `chmod 777`, a nested `curl | bash`, a firewall flush, `userdel`, `reboot` and `kubectl delete`. For PowerShell it flags `Remove-Item -Recurse`, `Format-Volume` and `iex (iwr …)`; for Python, `shutil.rmtree` and `shell=True`.
- **Preview command.** A second command prints the script on the server instead of running it, so whoever runs it can read it first.
- **Only run on hosts.** Patterns such as `prod-db-*, web-1`. On any other host the script refuses to run (`uname -n`, or `[Environment]::MachineName`), which protects against the wrong terminal.
- **Ask on server.** Environment settings the script reads (`$DB_PASSWORD`, `${PORT:-80}`, `$env:TOKEN`, `os.environ.get(...)`) appear as fields. Names containing PASS, SECRET, TOKEN or KEY default to "ask on server": the script asks for the value with typing hidden, so it never appears in the command, chat or history.
- **Fingerprint.** The first 8 characters of the script's SHA-256 appear at the start of the command (`: shellpin-a1b2c3d4;` or `<# shellpin a1b2c3d4 #>`) and in the preview, so a colleague can confirm they have the same script.

The expiry, host lock and secret prompts are written into the script, so they apply on SSH hosts and in containers too.

## Also in shellpin

- **[Saved scripts](https://yousafkhamza.github.io/shellpin/scripts.html).** Keep the scripts you run often in `scripts/` for a short command, e.g. `curl -fsSL https://yousafkhamza.github.io/shellpin/s/userctl.sh | sudo bash -s -- create jatin`. See below.
- **[Share a file](https://yousafkhamza.github.io/shellpin/f.html).** Hand over an SSH key or kubeconfig as a link. See below.

## Saved scripts

Saved scripts are served from GitHub Pages and piped straight into `bash`, so no copy is left on the server. Every script has an `@expires` date no more than **365 days** out. A daily workflow rebuilds the site without expired scripts and deletes them from the repository.

- **One-liner builder.** Pick a script, type the arguments, and copy a ready command, with or without `sudo`.
- **Verified mode.** The script is read into a shell variable, its SHA-256 is checked, and it runs with `bash -c`. Nothing touches the disk, and a changed or tampered script is refused:
  ```bash
  if s="$(curl -fsSL https://…/s/userctl.sh)" && [ "$(printf '%s' "$s" | sha256sum | cut -d' ' -f1)" = <sha256> ]; \
  then sudo bash -c "$s" userctl create jatin; else echo "shellpin: download failed or checksum mismatch" >&2; fi
  ```
- **Publish from the browser.** Paste or drop a `.sh` file, pick an expiry (1 day to 1 year), then either open GitHub's new-file page pre-filled or commit directly with a fine-grained token. The token stays in session storage and is only sent to `api.github.com`.
- **Guard rails in CI.** Every push checks name format, expiry (present, valid, ≤ 365 days), LF line endings, a shebang, size (≤ 120 KB, which keeps `bash -c` under the kernel's per-argument limit) and literal credentials (private keys, AWS/GitHub/Slack/Google keys). ShellCheck errors fail the build; warnings appear as annotations.
- **File handoff without uploads.** Hand over an SSH key, kubeconfig or `.env` as a link (see below).
- **Static, no dependencies.** It's a Node build script and a plain HTML/JS page. There's nothing to install and no server to run.

## Handing over a key or file

```bash
curl -fsSL https://yousafkhamza.github.io/shellpin/s/share.sh | bash -s -- ./jatin.pem --hours 24
```
```
Link for jatin.pem (opens until 2026-11-27 13:00 UTC; nothing was uploaded):
https://yousafkhamza.github.io/shellpin/f.html#f1.p.U2FsdGVkX1…

Passphrase: 6fa1a3ee7518d2f7d7838899
Send the passphrase through a different channel than the link.
```

The file is gzipped, encrypted with `openssl enc -aes-256-cbc -pbkdf2 -iter 250000`, and placed after the `#` in the link. Browsers never send that part to a server, so the file isn't stored anywhere: not on GitHub Pages, not on a paste site. The script also needs no network once it's on the server.

The receiver opens the link and enters the passphrase. [f.html](site/f.html) decrypts it in the browser and offers `jatin.pem` as a download, along with the `chmod 600` / `icacls` and `ssh -i` commands. The page's Content-Security-Policy is `connect-src 'none'`, so it can't send the file anywhere. The same page can also make links from a file in your browser.

`userctl.sh` uses the same link for new PEM keys, so it no longer depends on dpaste. Set `PEM_LINK_HOURS=2` to shorten the window, or `PEM_PASSPHRASE=no` for a link without a passphrase.

Limits:
- Up to 64 KB per file. An RSA-4096 key makes a link of about 3,500 characters.
- Passphrases need OpenSSL 1.1.1 or newer on the server. Amazon Linux 2's default 1.0.2 falls back to a link without a passphrase and prints a warning; `yum install openssl11` adds support.
- Expiry is enforced by the page. Someone who keeps a link and decodes it by hand isn't stopped, so delete links after use and rotate a key if one leaks.

## Adding a script

Put a file in `scripts/` with tags in the first 40 lines:

```bash
#!/bin/bash
# @description What it does, shown on the site
# @usage create|delete <user>
# @expires 2027-06-30
set -euo pipefail
…
```

Push to `main`. The site serves it at `https://<owner>.github.io/<repo>/s/<name>.sh`, with a checksum at `…/s/<name>.sh.sha256`.

To **renew**, change `@expires` (up to 365 days from the day of the push). To **retire early**, delete the file.

## Expiry: what it does and doesn't do

| | |
|---|---|
| Site rebuild | Daily at 00:07 UTC. A script is gone from the site on its `@expires` day. |
| CDN cache | GitHub Pages caches for up to 10 minutes after a deploy. |
| Repository | The daily job commits the deletion to `main`. |
| Git history | **Keeps every version forever.** Anyone with access to the repo (or a clone) can still read expired scripts. |

So expiry controls *what's runnable*, not *what's secret*. Never commit passwords, keys or tokens; pass them as arguments or environment variables at run time.

## Set up your own copy

1. Create a repository (public, or private on a plan with Pages) and push this folder.
2. **Settings → Pages → Source: GitHub Actions.**
3. Push to `main`. The `Check and publish` workflow tests, builds and deploys.
4. If `main` is protected, allow `github-actions[bot]` to push, or the daily prune job fails (expired scripts are still left off the site).

For browser commits, create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **only this repository** and **Contents: read and write**, with a short expiry.

## Local commands

```bash
npm test            # unit tests (node:test)
npm run check       # validate scripts/ only
npm run build       # build the site into dist/
npm run prune       # delete expired scripts from scripts/
node tools/build.mjs --today=2027-01-01   # pretend it's another day
```

Node 20 or newer, no `npm install` needed.

## Troubleshooting

**`curl: (60) SSL certificate … unable to get local issuer certificate`**

The server can't verify that host's TLS certificate. If GitHub Pages works but one other host fails (dpaste.com did this), the fault is that host's certificate chain, so stop depending on it. If every host fails, the server's CA bundle is missing or stale, or a proxy is re-signing HTTPS. Don't switch to `curl -k`: that lets anyone on the path swap the script you're running as root.

```bash
# Amazon Linux 2 / RHEL / CentOS
sudo yum reinstall -y ca-certificates && sudo update-ca-trust extract
# Amazon Linux 2023 / Fedora / Rocky / Alma
sudo dnf reinstall -y ca-certificates && sudo update-ca-trust extract
# Debian / Ubuntu
sudo apt-get install --reinstall -y ca-certificates && sudo update-ca-certificates

# Behind a TLS-inspecting proxy, trust the proxy's CA:
sudo cp corp-root-ca.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust extract   # RHEL family
sudo cp corp-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates     # Debian family

# See who issued the certificate the server is actually getting:
curl -sv https://yousafkhamza.github.io -o /dev/null 2>&1 | grep -iE 'issuer|subject'
```

**The command printed nothing and did nothing.** Use `curl -fsSL`, not `curl -s`. With `-s` alone, a failed download prints no error and pipes an empty body (or an HTML error page) into `bash`.

**`$'\r': command not found`.** The script has Windows line endings. The build rejects these, and `.gitattributes` makes git store `*.sh` with LF.

## License

MIT © Yousaf K Hamza
