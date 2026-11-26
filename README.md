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
- **Static, no dependencies.** It's a Node build script and a plain HTML/JS page. There's nothing to install and no server to run.

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

The server can't verify the TLS certificate. Its CA bundle is missing or stale, or a proxy is re-signing HTTPS. Don't switch to `curl -k`: that lets anyone on the path swap the script you're running as root.

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
