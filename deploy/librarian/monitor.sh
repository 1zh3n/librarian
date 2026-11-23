#!/usr/bin/env bash
# Check a public Librarian deployment and POST failures to a webhook.
# Configure /etc/librarian/alert.env or pass the same variables in the unit.
set -euo pipefail

PUBLIC="${LIBRARIAN_PUBLIC_URL:-https://librarian.zanghua.dev}"
LOCAL="${LIBRARIAN_LOCAL_URL:-http://127.0.0.1:8080}"
BACKUP_DIR="${LIBRARIAN_BACKUP_DIR:-/var/backups/librarian}"
DISK_MAX="${LIBRARIAN_DISK_MAX_PERCENT:-85}"
MEMORY_MIN="${LIBRARIAN_MEMORY_MIN_MB:-128}"
LOAD_MAX="${LIBRARIAN_LOAD_MAX:-4}"
CERT_MIN_DAYS="${LIBRARIAN_CERT_MIN_DAYS:-14}"
BACKUP_MAX_HOURS="${LIBRARIAN_BACKUP_MAX_HOURS:-30}"
WEBHOOK="${ALERT_WEBHOOK_URL:-}"

failures=()

fail() {
  failures+=("$1")
}

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if ! curl -fsS --max-time 10 "$LOCAL/api/v1/health" | grep -q '"status":"ok"'; then
  fail "local health endpoint"
fi
if ! curl -fsS --max-time 15 "$PUBLIC/api/v1/health" | grep -q '"status":"ok"'; then
  fail "public health endpoint"
fi

if ! systemctl is-active --quiet librarian; then
  fail "librarian.service is not active"
fi
if ! systemctl is-active --quiet caddy; then
  fail "caddy.service is not active"
fi

disk="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if [[ -n "$disk" ]] && (( disk > DISK_MAX )); then
  fail "disk usage ${disk}% exceeds ${DISK_MAX}%"
fi

memory="$(awk '/MemAvailable/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
if [[ -n "$memory" ]] && (( memory < MEMORY_MIN )); then
  fail "available memory ${memory} MB is below ${MEMORY_MIN} MB"
fi

load="$(awk '{ print $1 }' /proc/loadavg)"
if [[ -n "$load" ]] && awk -v current="$load" -v max="$LOAD_MAX" 'BEGIN { exit !(current > max) }'; then
  fail "load average ${load} exceeds ${LOAD_MAX}"
fi

cert_host="${PUBLIC#https://}"
cert_host="${cert_host%%/*}"
cert_end="$(
  timeout 15 openssl s_client -connect "${cert_host}:443" -servername "$cert_host" </dev/null 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | cut -d= -f2-
)"
if [[ -z "$cert_end" ]]; then
  fail "public certificate expiry is unreadable"
else
  cert_epoch="$(date -d "$cert_end" +%s)"
  cert_days=$(( (cert_epoch - $(date +%s)) / 86400 ))
  if (( cert_days < CERT_MIN_DAYS )); then
    fail "public certificate expires in ${cert_days} days"
  fi
fi

latest_backup="$(
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'librarian-data-*.tar.gz' -printf '%T@\n' 2>/dev/null \
    | sort -nr | head -1 | cut -d. -f1
)"
if [[ -z "$latest_backup" ]]; then
  fail "no backup archive found in ${BACKUP_DIR}"
else
  backup_hours=$(( ($(date +%s) - latest_backup) / 3600 ))
  if (( backup_hours > BACKUP_MAX_HOURS )); then
    fail "latest backup is ${backup_hours} hours old"
  fi
fi

if (( ${#failures[@]} == 0 )); then
  echo "monitor ok"
  exit 0
fi

payload="$(
  jq -n \
    --arg host "$(hostname)" \
    --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg public "$PUBLIC" \
    --argjson failures "$(printf '%s\n' "${failures[@]}" | jq -R . | jq -s .)" \
    '{ service: "librarian", status: "alert", host: $host, time: $time, publicUrl: $public, failures: $failures }'
)"
if [[ -n "$WEBHOOK" ]]; then
  if ! curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' --data "$payload" "$WEBHOOK" >/dev/null; then
    echo "alert webhook delivery failed" >&2
    echo "$payload" >&2
    exit 1
  fi
  echo "alert sent"
else
  echo "$payload" >&2
fi
exit 1
