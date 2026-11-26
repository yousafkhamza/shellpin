# shellpin

Run-once shell scripts for your servers, hosted on GitHub Pages and taken down on an expiry date.

```bash
curl -fsSL https://yousafkhamza.github.io/shellpin/s/userctl.sh | sudo bash -s -- create jatin
```

The script is piped straight into `bash`, so no copy is left on the server. Every script has an `@expires` date no more than **365 days** out. A daily workflow rebuilds the site without expired scripts and deletes them from the repository.

It replaces pastebin-style hosting (dpaste and similar) for scripts you run often. You get version control, review, ShellCheck, checksums, and an expiry you control.

## Features

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
