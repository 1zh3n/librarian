#!/usr/bin/env bash
# Read-only smoke check for a running Librarian instance.
# Usage: smoke.sh [local-base] [public-base]
set -euo pipefail

BASE="${1:-http://127.0.0.1:8080}"
PUBLIC="${2:-}"

health="$(curl -fsS --max-time 10 "$BASE/api/v1/health")"
grep -q '"status":"ok"' <<<"$health" || {
  echo "health did not report ok: $health" >&2
  exit 1
}

root_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/")"
if [[ "$root_status" != "200" ]]; then
  echo "app shell returned $root_status" >&2
  exit 1
fi

login_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/.auth/librarian/login")"
if [[ "$login_status" != "200" ]]; then
  echo "login page returned $login_status" >&2
  exit 1
fi

if [[ -n "$PUBLIC" ]]; then
  headers="$(curl -sS -D - -o /dev/null --max-time 10 "$PUBLIC/")"
  for expected in \
    '^content-security-policy:' \
    '^strict-transport-security:' \
    '^referrer-policy: no-referrer' \
    '^x-frame-options: DENY' \
    '^x-content-type-options: nosniff'
  do
    if ! grep -qi "$expected" <<<"$headers"; then
      echo "public response is missing $expected" >&2
      exit 1
    fi
  done
fi

echo "smoke ok"
