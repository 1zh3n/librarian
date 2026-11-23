#!/usr/bin/env bash
# Install the pinned Caddy binary and a hardened systemd unit.
# Run as root on the deployment host.
set -euo pipefail
umask 077

VERSION="2.11.9"
SHA256="5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb"
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

install -m 0644 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/caddy.service" /etc/systemd/system/caddy.service

systemctl daemon-reload
echo "Installed Caddy ${VERSION}."
echo "Next: write /etc/librarian/caddy.env and /etc/caddy/Caddyfile, then:"
echo "  systemctl enable --now caddy"
