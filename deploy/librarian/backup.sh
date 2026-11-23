#!/usr/bin/env bash
# Back up the Librarian data root. Run as root on the deployment host.
#
# Stops the service for a consistent archive, checks the SQLite database, writes
# a checksum, keeps the newest archives, and optionally pushes the archive to a
# restic repository when RESTIC_REPOSITORY is configured.
set -euo pipefail
umask 077

SERVICE="${LIBRARIAN_SERVICE:-librarian.service}"
DATA_ROOT="${LIBRARIAN_DATA_ROOT:-/var/lib/librarian/data}"
BACKUP_DIR="${LIBRARIAN_BACKUP_DIR:-/var/backups/librarian}"
KEEP="${LIBRARIAN_BACKUP_KEEP:-14}"
DB="$DATA_ROOT/.librarian/metadata.sqlite3"

if [[ $EUID -ne 0 ]]; then
  echo "backup.sh must run as root" >&2
  exit 1
fi
if [[ ! -d "$DATA_ROOT" ]]; then
  echo "missing data root: $DATA_ROOT" >&2
  exit 1
fi
if [[ ! -f "$DB" ]]; then
  echo "missing metadata database: $DB" >&2
  exit 1
fi
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

install -d -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_DIR/librarian-data-$stamp.tar.gz"
restart=0
completed=0

if systemctl is-active --quiet "$SERVICE"; then
  systemctl stop "$SERVICE"
  restart=1
fi

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 && "$completed" -eq 0 ]]; then
    rm -f -- "$archive" "$archive.sha256"
  fi
  if [[ "$restart" -eq 1 ]]; then
    systemctl start "$SERVICE" || true
  fi
}
trap cleanup EXIT

integrity="$(sqlite3 "$DB" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
  echo "sqlite integrity check failed: $integrity" >&2
  exit 1
fi

tar --numeric-owner --xattrs --acls \
  -C "$(dirname "$DATA_ROOT")" \
  -czf "$archive" \
  "$(basename "$DATA_ROOT")"
sha256sum "$archive" > "$archive.sha256"
completed=1

# Bring the service back before the optional offsite copy so the copy does not
# extend the maintenance window.
if [[ "$restart" -eq 1 ]]; then
  systemctl start "$SERVICE"
  restart=0
fi

# Keep the newest KEEP archives and checksums. The archive names sort by time.
mapfile -t old < <(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'librarian-data-*.tar.gz' -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +"$((KEEP + 1))" \
    | cut -d' ' -f2-
)
for file in "${old[@]}"; do
  rm -f -- "$file" "$file.sha256"
done

if command -v restic >/dev/null && [[ -n "${RESTIC_REPOSITORY:-}" ]]; then
  restic backup --tag librarian "$archive"
  restic forget --tag librarian --keep-daily 14 --keep-weekly 8 --prune
fi

echo "$archive"
