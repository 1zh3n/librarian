#!/usr/bin/env bash
# Restore a Librarian data archive created by backup.sh.
# Run as root; the script asks for an explicit confirmation before replacing data.
set -euo pipefail
umask 077

ARCHIVE="${1:-}"
SERVICE="${LIBRARIAN_SERVICE:-librarian.service}"
DATA_ROOT="${LIBRARIAN_DATA_ROOT:-/var/lib/librarian/data}"
HEALTH_URL="${LIBRARIAN_HEALTH_URL:-http://127.0.0.1:8080/api/v1/health}"

if [[ $EUID -ne 0 ]]; then
  echo "restore.sh must run as root" >&2
  exit 1
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "usage: restore.sh /var/backups/librarian/librarian-data-<stamp>.tar.gz" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE.sha256" ]]; then
  echo "missing checksum: $ARCHIVE.sha256" >&2
  exit 1
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

(
  cd "$(dirname "$ARCHIVE")"
  sha256sum -c "$(basename "$ARCHIVE").sha256"
)

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

tar -xzf "$ARCHIVE" -C "$tmp"
restored="$tmp/$(basename "$DATA_ROOT")"
if [[ ! -f "$restored/.librarian/metadata.sqlite3" ]]; then
  echo "archive does not contain $(basename "$DATA_ROOT")/.librarian/metadata.sqlite3" >&2
  exit 1
fi
integrity="$(sqlite3 "$restored/.librarian/metadata.sqlite3" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "restored sqlite integrity check failed: $integrity" >&2
  exit 1
fi

printf 'This will replace %s. Type RESTORE to continue: ' "$DATA_ROOT"
read -r answer
if [[ "$answer" != "RESTORE" ]]; then
  echo "aborted" >&2
  exit 1
fi

systemctl stop "$SERVICE" || true
previous="$DATA_ROOT.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -e "$DATA_ROOT" ]]; then
  mv "$DATA_ROOT" "$previous"
fi
cp -a "$restored" "$DATA_ROOT"
chown -R librarian:librarian "$DATA_ROOT"
systemctl start "$SERVICE"

if ! curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null; then
  echo "health check failed; rolling back" >&2
  systemctl stop "$SERVICE" || true
  rm -rf "$DATA_ROOT"
  if [[ -e "$previous" ]]; then
    mv "$previous" "$DATA_ROOT"
  fi
  systemctl start "$SERVICE" || true
  exit 1
fi

echo "restored $DATA_ROOT"
if [[ -e "$previous" ]]; then
  echo "previous data root kept at $previous"
fi
