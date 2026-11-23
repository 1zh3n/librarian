#!/usr/bin/env node
// Checks the public and LAN Caddy entry points for the headers the app relies on.
// Run from the repository root: node deploy/librarian/verify-entry-config.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function read(name) {
  return readFileSync(join(here, name), "utf8");
}

function expectAll(name, text, needles) {
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    console.error(`${name} is missing:`);
    for (const needle of missing) console.error(`  - ${needle}`);
    process.exitCode = 1;
  }
}

const publicConfig = read("public.Caddyfile");
expectAll("public.Caddyfile", publicConfig, [
  "trusted_proxies static {$LIBRARIAN_TRUSTED_PROXIES}",
  "trusted_proxies_strict",
  "client_ip_headers CF-Connecting-IP X-Forwarded-For",
  "header_up X-Forwarded-Proto https",
  "header_up X-Real-IP {http.request.remote.host}",
  "header_up X-Forwarded-For {http.request.remote.host}",
  "flush_interval -1",
  "Strict-Transport-Security",
  "request_body {",
  "max_size 16MB",
  "health_uri /api/v1/health",
]);

const lanConfig = read("lan.Caddyfile");
expectAll("lan.Caddyfile", lanConfig, [
  "header_up X-Forwarded-Proto https",
  "header_up X-Real-IP {remote_host}",
]);

if (process.exitCode) {
  console.error("\nEntry configuration check failed.");
} else {
  console.log("Entry configuration check passed.");
}
