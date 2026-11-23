#!/usr/bin/env bash
# Install the pinned Caddy binary and a hardened systemd unit.
# Run as root on the deployment host.
set -euo pipefail
umask 077

VERSION="2.11.9"
SHA256="5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb"
AOP_URL="https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem"
AOP_SHA256="c14fed0ce5210db0719fea11d1f10b33750dc17d609aeaf47c75e9eff0d7b843"
ARCH="${CADDY_ARCH:-amd64}"
URL="https://github.com/caddyserver/caddy/releases/download/v${VERSION}/caddy_${VERSION}_linux_${ARCH}.tar.gz"

if [[ $EUID -ne 0 ]]; then
  echo "install-caddy.sh must run as root" >&2
  exit 1
fi
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null || { echo "tar is required" >&2; exit 1; }

if ! id caddy >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/caddy --shell /usr/sbin/nologin caddy
fi
install -d -m 0750 -o caddy -g caddy /var/lib/caddy
install -d -m 0755 /etc/caddy
install -d -m 0700 /etc/librarian

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/caddy.tar.gz" "$URL"
printf '%s  %s\n' "$SHA256" "$tmp/caddy.tar.gz" | sha256sum -c -
tar -xzf "$tmp/caddy.tar.gz" -C "$tmp" caddy
install -m 0755 "$tmp/caddy" /usr/local/bin/caddy

curl -fsSL --retry 3 -o "$tmp/origin-pull-ca.pem" "$AOP_URL"
printf '%s  %s\n' "$AOP_SHA256" "$tmp/origin-pull-ca.pem" | sha256sum -c -
install -m 0644 -o caddy -g caddy "$tmp/origin-pull-ca.pem" /etc/caddy/origin-pull-ca.pem

install -m 0644 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/caddy.service" /etc/systemd/system/caddy.service

systemctl daemon-reload
echo "Installed Caddy ${VERSION} and the Cloudflare origin-pull CA."
echo "Next: write /etc/librarian/caddy.env and /etc/caddy/Caddyfile, then:"
echo "  systemctl enable --now caddy"
