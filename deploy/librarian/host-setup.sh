#!/usr/bin/env bash
# Provision an Ubuntu 24.04 host for Librarian.
# Run as root on the target Vultr host.
#
# Usage:
#   host-setup.sh --admin-ssh-cidr 203.0.113.10/32 [--ssh-port 22] [--harden-ssh]
set -euo pipefail
umask 022

ADMIN_CIDR=""
SSH_PORT=22
HARDEN_SSH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --admin-ssh-cidr) ADMIN_CIDR="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-22}"; shift 2 ;;
    --harden-ssh) HARDEN_SSH=1; shift ;;
    -h|--help) sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "host-setup.sh must run as root" >&2
  exit 1
fi
if [[ -z "$ADMIN_CIDR" || ! "$ADMIN_CIDR" =~ ^[0-9a-fA-F:.]+/[0-9]{1,3}$ ]]; then
  echo "usage: host-setup.sh --admin-ssh-cidr <cidr> [--ssh-port 22] [--harden-ssh]" >&2
  exit 2
fi
if [[ "$SSH_PORT" != "22" ]]; then
  echo "Only SSH port 22 is automated; open the custom port manually before enabling the firewall." >&2
  exit 2
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    echo "Expected Ubuntu; found ${PRETTY_NAME:-unknown}." >&2
    exit 1
  fi
  if [[ "$(printf '%s\n' "24.04" "${VERSION_ID:-0}" | sort -V | head -n 1)" != "24.04" ]]; then
    echo "Expected Ubuntu 24.04 or newer for glibc 2.39; found ${VERSION_ID:-unknown}." >&2
    exit 1
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates chrony curl fail2ban git jq sqlite3 ufw unattended-upgrades

systemctl disable --now systemd-timesyncd 2>/dev/null || true
systemctl enable --now chrony
systemctl enable --now unattended-upgrades
systemctl enable --now fail2ban

if ! id librarian >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/librarian --shell /usr/sbin/nologin librarian
fi
install -d -m 0755 /opt/librarian/releases
install -d -m 0700 /etc/librarian /var/backups/librarian
install -d -m 0700 -o librarian -g librarian /var/lib/librarian

if ! swapon --show | grep -q .; then
  memory_mb="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)"
  if [[ "${memory_mb:-0}" -lt 4600 ]]; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 2G /swapfile
      chmod 0600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi
fi

install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/librarian.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald

if [[ "$HARDEN_SSH" -eq 1 ]]; then
  if [[ ! -s /root/.ssh/authorized_keys ]]; then
    echo "Refusing to enable key-only SSH without /root/.ssh/authorized_keys" >&2
    exit 1
  fi
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat >/etc/ssh/sshd_config.d/10-librarian.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  sshd -t
  systemctl reload ssh
  echo "SSH now requires a key. Verify a second root key session before closing this one."
fi

# Fetch Cloudflare ranges, write the Caddy environment, and add firewall rules.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$repo_dir/cloudflare-ips.sh" --apply

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow from "$ADMIN_CIDR" to any port 22 proto tcp >/dev/null
ufw --force enable >/dev/null

cat <<'EOF'
Host baseline complete.

Next:
  1. bash deploy/librarian/install-caddy.sh
  2. Install /opt/librarian/current and run `librarian init --admin-invite`.
  3. Install /etc/librarian/librarian.env and librarian.service.
  4. Copy public.Caddyfile to /etc/caddy/Caddyfile and write caddy.env.
  5. systemctl enable --now librarian caddy
  6. Install the backup timer and monitoring.
EOF
