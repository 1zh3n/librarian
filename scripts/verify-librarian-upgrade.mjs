import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [previous, candidate, fixtureBinary] = process.argv.slice(2);
if (process.argv.length !== 5) {
  throw new Error("Usage: node scripts/verify-librarian-upgrade.mjs PREVIOUS.tar.gz CANDIDATE.tar.gz DEBUG_LIBRARIAN");
}
if (!existsSync(fixtureBinary)) throw new Error("Build the debug Librarian fixture from the candidate revision");
const work = mkdtempSync(join(tmpdir(), "librarian-verified-upgrade-"));

async function unpack(archive, label) {
  const name = basename(archive);
  assert.match(name, /^librarian-[\w.+-]+-linux-x86_64\.tar\.gz$/);
  const expected = readFileSync(archive + ".sha256", "utf8").trim().split(/\s+/);
  assert.equal(expected.length, 2, "Expected a single release checksum");
  assert.equal(expected[1], name, "Checksum filename mismatch");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const digest = hash.digest("hex");
  assert.equal(digest, expected[0], `${label} archive checksum mismatch`);
  const dir = join(work, label);
  mkdirSync(dir);
  execFileSync("tar", ["-xzf", resolve(archive), "-C", dir]);
  const distribution = join(dir, name.slice(0, -".tar.gz".length));
  const src = readFileSync(join(distribution, "BUILD-INFO.txt"), "utf8").match(/^Source ([0-9a-f]{40})$/m);
  assert(src, "Release is missing its source revision");
  console.log(`${label} source ${src[1]} archive SHA-256 ${digest}`);
  return { distribution, revision: src[1] };
}

try {
  const oldRelease = await unpack(previous, "previous");
  const newRelease = await unpack(candidate, "candidate");
  assert.notEqual(oldRelease.revision, newRelease.revision, "Previous and candidate have the same source revision");
  const newDir = newRelease.distribution;
  execFileSync(join(newDir, "bin/node"), [join(root, "scripts/test-librarian-release.mjs"), newDir], {
    cwd: root, stdio: "inherit", env: {
      ...process.env, LIBRARIAN_PREVIOUS_BINARY: join(oldRelease.distribution, "librarian"),
      LIBRARIAN_DISCOVERY_FIXTURE_BINARY: resolve(fixtureBinary),
    },
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
