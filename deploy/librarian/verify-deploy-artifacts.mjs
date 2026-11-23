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

for (const script of ["backup.sh", "restore.sh", "deploy.sh", "smoke.sh"]) {
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

const backupUnit = read(join(here, "librarian-backup.service"));
expectAll("librarian-backup.service", backupUnit, [
  "Type=oneshot",
  "EnvironmentFile=-/etc/librarian/backup.env",
  "ExecStart=/bin/bash /opt/librarian/current/deploy/librarian/backup.sh",
]);

const timer = read(join(here, "librarian-backup.timer"));
expectAll("librarian-backup.timer", timer, ["OnCalendar=", "Persistent=true", "WantedBy=timers.target"]);

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
