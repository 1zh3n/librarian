#!/usr/bin/env bash
# Install a new Librarian release and switch the current symlink.
# Run as root on the deployment host. The previous release stays on disk.
set -euo pipefail
umask 077

ARCHIVE="${1:-}"
RELEASES="${LIBRARIAN_RELEASES:-/opt/librarian/releases}"
CURRENT="${LIBRARIAN_CURRENT:-/opt/librarian/current}"
SERVICE="${LIBRARIAN_SERVICE:-librarian.service}"
HEALTH_URL="${LIBRARIAN_HEALTH_URL:-http://127.0.0.1:8080/api/v1/health}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "deploy.sh must run as root" >&2
  exit 1
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "usage: deploy.sh /path/to/librarian-0.1.0-linux-x86_64.tar.gz" >&2
  exit 1
fi
if [[ ! -f "$ARCHIVE.sha256" ]]; then
  echo "missing checksum: $ARCHIVE.sha256" >&2
  exit 1
fi

(
  cd "$(dirname "$ARCHIVE")"
  sha256sum -c "$(basename "$ARCHIVE").sha256"
)

install -d -m 0755 "$RELEASES"
name="$(basename "$ARCHIVE" .tar.gz)"
dest="$RELEASES/$name-$(date -u +%Y%m%dT%H%M%SZ)"

cleanup_failed_extract() {
  local status=$?
  if [[ "$status" -ne 0 && -d "$dest" ]]; then
    rm -rf "$dest"
  fi
}
trap cleanup_failed_extract EXIT

install -d -m 0755 "$dest"
tar -xzf "$ARCHIVE" -C "$dest" --strip-components=1
if [[ ! -x "$dest/librarian" ]]; then
  echo "release does not contain an executable librarian binary" >&2
  exit 1
fi
chown -R root:root "$dest"
chmod 0755 "$dest"

previous=""
if [[ -L "$CURRENT" ]]; then
  previous="$(readlink -f "$CURRENT" || true)"
fi

# Keep a consistent data archive before touching the running release.
bash "$SCRIPT_DIR/backup.sh"

ln -sfn "$dest" "$CURRENT.next"
mv -Tf "$CURRENT.next" "$CURRENT"

restart_and_check() {
  systemctl restart "$SERVICE"
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if ! restart_and_check; then
  echo "health check failed after switching to $dest" >&2
  if [[ -n "$previous" && -d "$previous" ]]; then
    echo "rolling back to $previous" >&2
    ln -sfn "$previous" "$CURRENT.next"
    mv -Tf "$CURRENT.next" "$CURRENT"
    systemctl restart "$SERVICE" || true
  fi
  exit 1
fi

trap - EXIT
echo "deployed $dest"
