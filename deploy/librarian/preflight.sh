#!/usr/bin/env bash
# External preflight for a public Librarian deployment.
# Run from a machine outside the Vultr host (or with --local-health on it).
#
# Usage:
#   preflight.sh --domain app.example.com --origin-ip 203.0.113.7 [--local-health]
set -euo pipefail

DOMAIN=""
ORIGIN_IP=""
LOCAL_HEALTH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --origin-ip) ORIGIN_IP="${2:-}"; shift 2 ;;
    --local-health) LOCAL_HEALTH=1; shift ;;
    -h|--help) sed -n '1,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$ORIGIN_IP" ]]; then
  echo "usage: preflight.sh --domain app.example.com --origin-ip 203.0.113.7" >&2
  exit 2
fi

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
failures=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if curl -fsS --max-time 15 "https://$DOMAIN/" -D "$tmp/headers" -o /dev/null; then
  pass "HTTPS URL responds"
else
  fail "HTTPS URL does not respond"
fi
for header in \
  '^strict-transport-security:' \
  '^content-security-policy:' \
  '^referrer-policy: no-referrer' \
  '^x-frame-options: DENY' \
  '^x-content-type-options: nosniff'
do
  if grep -qi "$header" "$tmp/headers"; then
    pass "public header $header"
  else
    fail "public header $header"
  fi
done

status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://$DOMAIN/" || true)"
if [[ "$status" == "301" || "$status" == "308" ]]; then
  pass "HTTP redirects to HTTPS"
else
  fail "HTTP did not redirect to HTTPS (status $status)"
fi

if curl -kfs --max-time 8 --resolve "$DOMAIN:443:$ORIGIN_IP" "https://$DOMAIN/" -o /dev/null; then
  fail "origin IP answered directly; restrict the firewall to Cloudflare"
else
  pass "origin IP is not directly reachable"
fi

if [[ "$LOCAL_HEALTH" -eq 1 ]]; then
  if curl -fsS --max-time 10 http://127.0.0.1:8080/api/v1/health | grep -q '"status":"ok"'; then
    pass "local health endpoint"
  else
    fail "local health endpoint"
  fi
fi

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check(s) failed." >&2
  exit 1
fi
echo "Preflight passed."
