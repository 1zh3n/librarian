#!/usr/bin/env node
// Checks the deployment artifacts that ship in the release tarball.
// Run from the repository root: node deploy/librarian/verify-deploy-artifacts.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
let failed = false;

function fail(message) {
  console.error(`FAIL ${message}`);
  failed = true;
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`missing ${path}`);
    return "";
  }
}

function expectAll(label, text, needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`${label} is missing ${needle}`);
  }
}

for (const script of [
  "backup.sh",
  "restore.sh",
  "deploy.sh",
  "smoke.sh",
  "monitor.sh",
  "host-setup.sh",
  "install-caddy.sh",
  "cloudflare-ips.sh",
  "preflight.sh",
]) {
  const path = join(here, script);
  const text = read(path);
  if (!text.startsWith("#!/usr/bin/env bash")) fail(`${script} has no bash shebang`);
  expectAll(script, text, ["set -euo pipefail"]);
}

const unit = read(join(here, "librarian.service"));
expectAll("librarian.service", unit, [
  "User=librarian",
  "EnvironmentFile=/etc/librarian/librarian.env",
  "ExecStart=/opt/librarian/current/librarian",
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
  "ProtectHome=true",
  "ReadWritePaths=/var/lib/librarian",
  "StateDirectory=librarian",
  "UMask=0077",
  "Restart=on-failure",
]);

const caddyUnit = read(join(here, "caddy.service"));
expectAll("caddy.service", caddyUnit, [
  "User=caddy",
  "EnvironmentFile=/etc/librarian/caddy.env",
  "EnvironmentFile=-/etc/librarian/cloudflare.env",
  "ExecStart=/usr/local/bin/caddy run",
  "AmbientCapabilities=CAP_NET_BIND_SERVICE",
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
]);

const caddyInstall = read(join(here, "install-caddy.sh"));
expectAll("install-caddy.sh", caddyInstall, [
  'VERSION="2.11.9"',
  'SHA256="5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb"',
  "sha256sum -c -",
  "origin-pull-ca.pem",
]);

const caddyfile = read(join(here, "public.Caddyfile"));
expectAll("public.Caddyfile", caddyfile, [
  "client_auth",
  "mode require_and_verify",
  "trust_pool file {$LIBRARIAN_ORIGIN_PULL_CA:/etc/caddy/origin-pull-ca.pem}",
  "trusted_proxies_strict",
  "client_ip_headers CF-Connecting-IP X-Forwarded-For",
]);

const backupUnit = read(join(here, "librarian-backup.service"));
expectAll("librarian-backup.service", backupUnit, [
  "Type=oneshot",
  "EnvironmentFile=-/etc/librarian/backup.env",
  "ExecStart=/bin/bash /opt/librarian/current/deploy/librarian/backup.sh",
]);

const backupTimer = read(join(here, "librarian-backup.timer"));
expectAll("librarian-backup.timer", backupTimer, ["OnCalendar=", "Persistent=true", "WantedBy=timers.target"]);

const monitorUnit = read(join(here, "librarian-monitor.service"));
expectAll("librarian-monitor.service", monitorUnit, [
  "Type=oneshot",
  "EnvironmentFile=-/etc/librarian/alert.env",
  "ExecStart=/bin/bash /opt/librarian/current/deploy/librarian/monitor.sh",
]);

const monitorTimer = read(join(here, "librarian-monitor.timer"));
expectAll("librarian-monitor.timer", monitorTimer, ["OnUnitActiveSec=5min", "WantedBy=timers.target"]);

const hostSetup = read(join(here, "host-setup.sh"));
expectAll("host-setup.sh", hostSetup, [
  "fail2ban",
  "PermitRootLogin prohibit-password",
  "PasswordAuthentication no",
  "/root/.ssh/authorized_keys",
]);

const staging = read(join(root, "scripts", "stage-librarian-release-files.mjs"));
for (const file of [
  "deploy/librarian/public.Caddyfile",
  "deploy/librarian/librarian.service",
  "deploy/librarian/librarian.env.example",
  "deploy/librarian/backup.sh",
  "deploy/librarian/restore.sh",
  "deploy/librarian/deploy.sh",
  "deploy/librarian/smoke.sh",
  "deploy/librarian/librarian-backup.service",
  "deploy/librarian/librarian-backup.timer",
  "deploy/librarian/backup.env.example",
  "deploy/librarian/monitor.sh",
  "deploy/librarian/librarian-monitor.service",
  "deploy/librarian/librarian-monitor.timer",
  "deploy/librarian/alert.env.example",
  "deploy/librarian/host-setup.sh",
  "deploy/librarian/install-caddy.sh",
  "deploy/librarian/caddy.service",
  "deploy/librarian/cloudflare-ips.sh",
  "deploy/librarian/preflight.sh",
  "deploy/librarian/verify-entry-config.mjs",
  "docs/librarian/public-deployment.md",
  "docs/librarian/incident-response.md",
]) {
  if (!staging.includes(`"${file}"`)) fail(`release staging does not include ${file}`);
}

if (failed) {
  console.error("\nDeployment artifact check failed.");
  process.exitCode = 1;
} else {
  console.log("Deployment artifact check passed.");
}
