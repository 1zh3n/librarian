import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("./verify-librarian-upgrade.mjs", import.meta.url));
const name = "librarian-test-linux-x86_64";

function archive(directory, source, label) {
  const release = join(directory, name);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "BUILD-INFO.txt"), `Source ${source}\n${label}\n`);
  const path = join(directory, name + ".tar.gz");
  execFileSync("tar", ["-czf", path, "-C", directory, name]);
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(path + ".sha256", `${digest}  ${name}.tar.gz\n`);
  return path;
}

function run(previous, candidate) {
  return spawnSync(process.execPath, [verifier, previous, candidate, process.execPath], {
    encoding: "utf8",
    timeout: 5_000,
  });
}

test("upgrade verification rejects distinct archives of the same source before launching a binary", () => {
  using work = mkdtempDisposableSync(join(tmpdir(), "upgrade-input-test-"));
  const revision = "a".repeat(40);
  const previous = archive(join(work.path, "previous"), revision, "original build");
  const candidate = archive(join(work.path, "candidate"), revision, "second build");
  const result = run(previous, candidate);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Previous and candidate have the same source revision/);
});

test("upgrade verification rejects a changed candidate before reading its metadata", () => {
  using work = mkdtempDisposableSync(join(tmpdir(), "upgrade-input-test-"));
  const previous = archive(join(work.path, "previous"), "a".repeat(40), "previous");
  const candidate = archive(join(work.path, "candidate"), "b".repeat(40), "candidate");
  writeFileSync(candidate, "changed archive bytes");
  const result = run(previous, candidate);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /candidate archive checksum mismatch/);
});
