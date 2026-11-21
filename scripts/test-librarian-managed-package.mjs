import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkManagedBundle(distribution) {
  const node = join(distribution, "bin/node");
  assert(existsSync(node), "archive must include a standalone Node 24 runtime");
  assert.match(execFileSync(node, ["--version"], { encoding: "utf8" }), /^v24\./);
  const runner = join(distribution, "bin/librarian/runner");
  const require = createRequire(join(runner, "package.json"));
  const manifest = require("./package.json");
  const lock = require("./package-lock.json");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
    assert.equal(JSON.parse(readFileSync(join(runner, "node_modules", name, "package.json"))).version, version);
  }
  assert.match(execFileSync(node, [join(runner, "runner.mjs"), "--help"], { encoding: "utf8" }), /LIBRARIAN_RUNNER_IDENTITY_FILE/);
  assert.match(readFileSync(join(distribution, "THIRD-PARTY-NOTICES.txt"), "utf8"), /@deepseek-ai\/dsh-agent@/);
  assert(existsSync(join(distribution, "licenses/node/LICENSE")));
  assert(statSync(join(distribution, "install-managed-runner")).mode & 0o100);
}

export function checkRunnerInstall(distribution, dataRoot, unitDir) {
  const installer = join(distribution, "install-managed-runner");
  const url = "http://127.0.0.1:18080";
  const name = "librarian-managed-smoke.service";
  const args = ["--data-root", dataRoot, "--librarian-url", url, "--unit-dir", unitDir, "--unit-name", name];
  const install = () => execFileSync(installer, args, { encoding: "utf8", timeout: 20_000 });
  const output = install();
  const file = join(dataRoot, ".librarian/managed-runner.json");
  assert(lstatSync(file).isFile());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const original = readFileSync(file, "utf8");
  const identity = JSON.parse(original);
  assert(identity.instanceId && identity.token);
  assert(!output.includes(identity.token));
  const unit = readFileSync(join(unitDir, name), "utf8");
  assert(unit.includes(url) && unit.includes("LIBRARIAN_RUNNER_IDENTITY_FILE"));
  assert(unit.includes("/bin/node") && unit.includes("/bin/librarian/runner/runner.mjs"));
  assert(!unit.includes(identity.token));
  assert(!install().includes(identity.token));
  assert.equal(readFileSync(file, "utf8"), original);
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Provide an unpacked Librarian release directory");
  checkManagedBundle(resolve(process.argv[2]));
  console.log("Packaged Node, locked Harness dependencies, runtime entrypoint and licenses passed.");
}
