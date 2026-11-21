// Real Reader and runner integration. Only the external Messages service is scripted.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stageManagedRunner } from "../../../../scripts/bundle-managed-runner.mjs";

import { createMessagesScenario, privateMarkers } from "./managed-messages.mjs";
export { first, comparison, materialTurn, privateMarkers } from "./managed-messages.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
function verifyStorage(dbPath, turns) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const deltas = db
      .prepare("SELECT operation_id, payload FROM ai_events WHERE kind='text_delta' ORDER BY seq")
      .all();
    const visible = new Map();
    for (const { operation_id, payload } of deltas) {
      visible.set(operation_id, (visible.get(operation_id) ?? "") + JSON.parse(payload).text);
    }
    assert.deepEqual(
      [...visible.values()],
      turns.map((t) => t.answer),
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_turns").get().n, turns.length);
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const table = '"' + name.replaceAll('"', '""') + '"';
      for (const row of db.prepare("SELECT * FROM " + table).iterate()) {
        for (const v of Object.values(row)) {
          const content = v instanceof Uint8Array ? Buffer.from(v).toString() : String(v);
          for (const marker of privateMarkers)
            assert.ok(!content.includes(marker), "Private text in SQLite table " + name);
        }
      }
    }
  } finally {
    db.close();
  }
  // The logical scan also covers SQLite values with non-text storage classes.
  // Inspect rollback/WAL pages in case a writer stored and then removed a marker.
  for (const suffix of ["", "-wal", "-journal"]) {
    let bytes;
    try {
      bytes = readFileSync(dbPath + suffix);
    } catch (error) {
      if (suffix && error.code === "ENOENT") continue;
      throw error;
    }
    for (const marker of privateMarkers)
      assert.ok(!bytes.includes(marker), "Private marker in SQLite " + (suffix || "database"));
  }
}

export async function startManagedReader() {
  const { ca, message, provider } = await import("../../runner/fixtures.mjs");
  const data = await mkdtemp(join(tmpdir(), "managed-reader-"));
  const metadata = join(data, ".librarian");
  const cleanup = [];
  const upstream = createMessagesScenario(message);
  const logs = [];
  const close = async () => {
    for (const gate of upstream.gates.values()) gate.resolve();
    try {
      for (const stop of cleanup.reverse()) await stop();
    } finally {
      await rm(data, { recursive: true, force: true });
    }
  };
  function processFor(exe, args, env) {
    const child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
    return child;
  }
  try {
    const p = await provider({ after: (fn) => cleanup.push(fn) }, upstream.respond);
    const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
    const prebuilt = process.env.LIBRARIAN_MANAGED_READER_FIXTURE;
    if (!prebuilt) {
      execFileSync(
        "cargo",
        [
          "build",
          "--quiet",
          "--locked",
          "-p",
          "librarian",
          "--example",
          "reader_managed_fixture",
          "--bin",
          "librarian",
        ],
        { cwd: root, timeout: 180_000 },
      );
    }
    const server = processFor(
      prebuilt ?? join(target, "debug/examples/reader_managed_fixture"),
      [data, new URL(p.messagesUrl).port],
      process.env,
    );
    const lines = createInterface({ input: server.stdout });
    const [origin] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(12_000) }),
      once(server, "exit").then(() => {
        throw new Error("Native Reader fixture exited before listening. " + logs.join(""));
      }),
    ]);
    lines.on("line", (line) => logs.push(line));
    const url = new URL(origin).origin;
    assert.equal((await fetch(url + "/api/v1/health")).status, 200);
    const identity = join(metadata, "managed-runner.json");
    execFileSync(
      join(target, "debug/librarian"),
      ["runner-enroll", "--data-root", data, "--identity-file", identity],
      { timeout: 12_000 },
    );
    const caPath = join(data, "fixture-ca.pem");
    await writeFile(caPath, ca);
    const bundle = process.env.LIBRARIAN_MANAGED_BUNDLE ?? join(data, "distribution");
    if (!process.env.LIBRARIAN_MANAGED_BUNDLE) {
      const dest = stageManagedRunner(root, bundle);
      // CI installs this lockfile before starting Playwright. Keep generation offline.
      cpSync(join(root, "bin/librarian/runner/node_modules"), join(dest, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const runner = processFor(
      join(bundle, "bin/node"),
      [join(bundle, "bin/librarian/runner/runner.mjs")],
      {
        PATH: process.env.PATH,
        NODE_EXTRA_CA_CERTS: caPath,
        LIBRARIAN_URL: url,
        LIBRARIAN_RUNNER_IDENTITY_FILE: identity,
      },
    );
    runner.stdout.on("data", (chunk) => logs.push(chunk.toString()));
    const dbPath = join(metadata, "metadata.sqlite3");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const online = db.prepare(
        "SELECT COUNT(*) AS n FROM ai_runner_instances WHERE last_seen >= unixepoch()-30",
      );
      const deadline = performance.now() + 12_000;
      while (online.get().n !== 1) {
        assert.ok(
          runner.exitCode === null && performance.now() < deadline,
          "Enrolled runner did not heartbeat to Rust v2",
        );
        await delay(50);
      }
    } finally {
      db.close();
    }
    return {
      url,
      failure: () =>
        upstream.failure() ?? (runner.exitCode !== null ? "managed runner exited" : undefined),
      finish: (turn) => {
        assert.ok(upstream.gates.has(turn));
        upstream.gates.get(turn).resolve();
      },
      verify: (turns) => {
        assert.deepEqual(upstream.finished, turns);
        verifyStorage(dbPath, turns);
        for (const marker of privateMarkers)
          assert.ok(!logs.join("").includes(marker), "Private text in child process logs");
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
