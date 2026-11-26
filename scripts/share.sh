#!/bin/bash
# @description Hand over a file (SSH key, kubeconfig, .env) as a link; nothing is uploaded anywhere
# @usage <file> [--hours N] [--name NAME] [--no-passphrase]
# @expires 2027-11-26
#
# The file is gzipped, optionally encrypted with openssl, and packed into the part of the link after
# "#". Browsers never send that part to a server; the shellpin page decodes it locally into a download.
# Set SHELLPIN_PASSPHRASE to choose the passphrase yourself, SHELLPIN_URL to point at your own fork.
set -euo pipefail

SHELLPIN_URL="${SHELLPIN_URL:-https://yousafkhamza.github.io/shellpin}"
MAX_BYTES=65536
MAX_HOURS=8760
ITER=250000

die() { echo "share: $*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOT'
Usage: share.sh <file> [--hours N] [--name NAME] [--no-passphrase]

  --hours N         the page refuses the link after N hours (default 24, max 8760 = 1 year)
  --name NAME       file name the receiver downloads (default: the file's own name)
  --no-passphrase   link only; anyone holding the link can open the file

Example:
  curl -fsSL https://yousafkhamza.github.io/shellpin/s/share.sh | bash -s -- ~/.kube/config --hours 2
EOT
  exit 1
}

FILE=""
HOURS=24
NAME=""
WANT_PASS=yes

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="${2:-}"; shift 2 || usage ;;
    --name) NAME="${2:-}"; shift 2 || usage ;;
    --no-passphrase) WANT_PASS=no; shift ;;
    -h|--help) usage ;;
    -*) die "unknown option $1" ;;
    *) [[ -z "$FILE" ]] || die "only one file at a time"; FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || usage
[[ -f "$FILE" && -r "$FILE" ]] || die "cannot read $FILE"
[[ "$HOURS" =~ ^[0-9]+$ ]] && (( HOURS >= 1 && HOURS <= MAX_HOURS )) || die "--hours must be 1..$MAX_HOURS"
SIZE=$(wc -c < "$FILE" | tr -d ' ')
(( SIZE <= MAX_BYTES )) || die "$FILE is $SIZE bytes; links are limited to $MAX_BYTES"
for tool in gzip base64 openssl; do command -v "$tool" >/dev/null || die "$tool is not installed"; done

NAME="${NAME:-$(basename "$FILE")}"
NAME="${NAME//[^A-Za-z0-9._-]/_}"

# -pbkdf2 needs OpenSSL 1.1.1+. Amazon Linux 2 ships 1.0.2 as `openssl` and 1.1.1 as `openssl11`.
OPENSSL=""
for bin in openssl openssl11 openssl3; do
  if command -v "$bin" >/dev/null && "$bin" enc -aes-256-cbc -pbkdf2 -iter 1 -md sha256 -pass pass:x -in /dev/null >/dev/null 2>&1; then
    OPENSSL="$bin"; break
  fi
done

PASS=""
if [[ "$WANT_PASS" == yes ]]; then
  if [[ -n "$OPENSSL" ]]; then
    PASS="${SHELLPIN_PASSPHRASE:-$("$OPENSSL" rand -hex 12)}"
  elif [[ -n "${SHELLPIN_PASSPHRASE:-}" ]]; then
    die "this openssl ($(openssl version)) has no -pbkdf2 (needs 1.1.1+); install openssl11 or use --no-passphrase"
  else
    echo "share: openssl $(openssl version | cut -d' ' -f2) is too old for passphrases (install openssl11); making a link without one." >&2
  fi
fi

EXPIRES=$(( $(date +%s) + HOURS * 3600 ))

encrypt() {
  if [[ -n "$PASS" ]]; then
    SHELLPIN_PASS="$PASS" "$OPENSSL" enc -aes-256-cbc -pbkdf2 -iter "$ITER" -md sha256 -salt -pass env:SHELLPIN_PASS
  else
    cat
  fi
}

DATA=$({ printf 'shellpin-file 1\nname: %s\nexpires: %s\n\n' "$NAME" "$EXPIRES"; cat "$FILE"; } \
  | gzip -9n | encrypt | base64 | tr -d '\n=' | tr '+/' '-_')
[[ -n "$DATA" ]] || die "could not build the link"

UNTIL=$(date -u -d "@$EXPIRES" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date -u -r "$EXPIRES" '+%Y-%m-%d %H:%M UTC')

echo ""
echo "Link for $NAME (opens until $UNTIL; nothing was uploaded):"
echo "${SHELLPIN_URL%/}/f.html#f1.$([[ -n "$PASS" ]] && echo p || echo z).$DATA"
if [[ -n "$PASS" ]]; then
  echo ""
  echo "Passphrase: $PASS"
  echo "Send the passphrase through a different channel than the link."
fi
echo ""
