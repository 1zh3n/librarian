import assert from "node:assert/strict";
import { checkManagedBundle, checkRunnerInstall } from "./test-librarian-managed-package.mjs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.argv.length, 3, "Provide the path to the unpacked release directory");
const distribution = resolve(process.argv[2]);
const librarian = join(distribution, "librarian");
const docs = join(distribution, "bin/docs");
const runner = join(distribution, "bin/librarian/examples/ai_runner.mjs");
const exec = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), "librarian-release-smoke-"));
const root = join(work, "data");
const repo = join(work, "backup.git");
const site = join(work, "site");
const target = join(work, "site.git");
const password = randomUUID();
const runnerToken = randomUUID();
const complete = /^[0-9a-f]{40}$/;
const note = "# 发行验收\r\n\r\n原始换行。\r\n";
const ship = "---\ntitle: 备份与发布\nstatus: published\npublication:\n  - target: blog\n    state: published\n    slug: report\n---\n\n[附件](asset.bin)\n";
const asset = Buffer.from([0, 13, 10, 128, 255]);
const accounts = ["init", "--username", "owner"];
let app;
let model;

function command(binary, args, options = {}) {
  return execFileSync(binary, args, { cwd: work, ...options });
}

function git(cwd, ...args) {
  return command("git", args, { cwd });
}

async function launch(binary, dataRoot) {
  const child = spawn(binary, ["--data-root", dataRoot, "--listen", "127.0.0.1:0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "close");
  exited.catch(() => {});
  try {
    let stdout = "";
    const listening = new Promise((accept) => {
      child.stderr.setEncoding("utf8").on("data", (line) => {
        stdout += line;
        const address = stdout.match(/Librarian listening on (127\.0\.0\.1:\d+)/)?.[1];
        if (address) accept(`http://${address}`);
      });
    });
    const origin = await Promise.race([
      listening,
      exited.then(() => assert.fail(`Librarian exited during startup\n${stdout}`)),
    ]);
    return {
      origin,
      async stop() {
        if (child.exitCode === null) child.kill("SIGINT");
        assert.deepEqual(await exited, [0, null]);
      },
    };
  } catch (error) {
    child.kill("SIGINT");
    throw error;
  }
}

async function login(origin) {
  const response = await fetch(`${origin}/.auth/librarian/login`, {
    method: "POST", redirect: "manual", headers: { origin },
    body: new URLSearchParams({ username: "owner", password }),
  });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return (path, method = "GET", body, status = 200) => request(origin, path, method, body, status, cookie);
}

async function request(origin, path, method, body, status, cookie) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method, signal: AbortSignal.timeout(90_000),
    headers: { origin, "content-type": "application/json", ...(cookie && { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status !== status) assert.fail(`${method} ${path}: ${response.status} ${await response.text()}`);
  if (status === 204) return;
  if (response.headers.get("content-type")?.startsWith("application/json")) return response.json();
  return Buffer.from(await response.arrayBuffer());
}

function initialize(dataRoot, binary = librarian) {
  command(binary, [...accounts, "--data-root", dataRoot], { input: `${password}\n` });
}

async function aiRound(api, first, second) {
  model = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      let payload = "";
      for await (const chunk of req) payload += chunk;
      const { messages } = JSON.parse(payload);
      const { sources } = JSON.parse(messages[1].content);
      assert.equal(sources.length, 2);
      const answer = {
        action: "finish", answer: "两份稿件均已修订。",
        edits: sources.map(({ sourceId, markdown }) => ({
          sourceId, markdown: markdown + "\n核对完成。\n",
        })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
      }));
    } catch {
      res.writeHead(500).end();
    }
  }).listen(0, "127.0.0.1");
  await once(model, "listening");
  const operation = await api("/ai/operations", "POST", {
    workspaceId: first.document.workspaceId, documentId: first.document.id,
    mode: "edit", prompt: "修订两份稿件。",
    context: [{ documentId: second.document.id, revision: second.revision }],
  }, 202);
  await exec(process.execPath, [runner, "--once"], {
    timeout: 60_000,
    env: {
      ...process.env, LIBRARIAN_URL: app.origin, LIBRARIAN_RUNNER_TOKEN: runnerToken,
      OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      OPENAI_MODEL: "local-release-test", OPENAI_API_KEY: "disposable-credential",
    },
  });
  const aiPath = `/ai/operations/${operation.id}`;
  const result = await api(aiPath);
  assert.equal(result.status, "succeeded", result.message);
  assert.equal(result.changes.length, 2);
  assert.match(result.commitId, complete);
  for (const original of [first, second]) {
    assert.equal((await api(`/documents/${original.document.id}`)).markdown,
      original.markdown + "\n核对完成。\n");
  }
  const undone = await api(`${aiPath}/undo`, "POST", {});
  assert.match(undone.commitId, complete);
  assert.notEqual(result.commitId, undone.commitId);
}

async function heartbeat(origin, file) {
  await exec(join(distribution, "bin/node"), [join(distribution, "bin/librarian/runner/runner.mjs"), "--once"], {
    cwd: work, timeout: 15_000,
    env: { LIBRARIAN_URL: origin, LIBRARIAN_RUNNER_IDENTITY_FILE: file },
  });
  const api = await login(origin);
  assert.equal((await api("/ai/settings")).runnerOnline, true);
}

try {
  checkManagedBundle(distribution);
  initialize(root);
  const identity = checkRunnerInstall(distribution, root, join(work, "clean units"));

  writeFileSync(join(root, ".librarian/runner-token.sha256"), createHash("sha256").update(runnerToken).digest("hex"));
  app = await launch(librarian, root);
  assert.equal((await fetch(`${app.origin}/sw.js`)).status, 200);
  assert.equal((await fetch(`${app.origin}/accounts`, { redirect: "manual" })).status, 200);
  await heartbeat(app.origin, identity);
  const api = await login(app.origin);
  assert.equal((await api("/session")).username, "owner");
  assert.deepEqual(await api("/accounts"), [{ username: "owner", isAdmin: true, disabled: false }]);
  const { id } = await api("/workspaces", "POST", { name: "本地发行验收" }, 201);
  const base = `/workspaces/${id}`;
  const create = (path, markdown) => api(`${base}/documents`, "POST", { path, markdown, baseRevision: null }, 201);
  const initial = await create("验收.md", note);
  const firstPath = `/documents/${initial.document.id}`;
  const first = await api(firstPath, "PUT", { markdown: note + "保存完成。\r\n", baseRevision: initial.revision });
  await api(firstPath, "PUT", { markdown: "过期保存", baseRevision: initial.revision }, 409);
  const second = await create("另一稿.md", "# 另一稿\n");
  await aiRound(api, first, second);
  assert.equal((await api(firstPath)).markdown, first.markdown);
  assert.equal((await api(`/documents/${second.document.id}`)).markdown, second.markdown);
  console.log("Passed clean initialization, revision conflicts, independent runner, two-file commit and undo");

  const delivery = await api(`${base}/delivery-tokens`, "POST", {
    name: "local-release-smoke", deliveryId: "release-report",
  }, 201);
  const input = join(work, "source");
  mkdirSync(input);
  writeFileSync(join(input, "report.md"), ship);
  writeFileSync(join(input, "asset.bin"), asset);
  const push = (workspace, deliveryId, token) => JSON.parse(command(docs, [
    "push", input, "--workspace", workspace, "--delivery-id", deliveryId,
    "--source-name", "Release smoke test", "--url", app.origin,
  ], { env: { ...process.env, LIBRARIAN_DELIVERY_TOKEN: token } }));
  const receipt = push(id, "release-report", delivery.token);
  assert.deepEqual(push(id, "release-report", delivery.token), receipt);
  assert.match(receipt.commitId, complete);
  const selected = (await api(`${base}/documents`)).find(({ path }) => path.endsWith("/report.md"));
  const snapshot = await api(`${base}/snapshots`, "POST", {
    kind: "release", audience: "share", documentIds: [selected.id], commitId: receipt.commitId,
    attachmentPaths: ["deliveries/release-report/asset.bin"],
  }, 201);
  const snapshotPath = `/snapshots/${snapshot.id}`;
  const readShare = () => request(app.origin, snapshotPath, "GET", undefined, 200);
  assert.equal((await readShare()).document.markdown, ship);
  assert.deepEqual(await request(app.origin, `${snapshotPath}/assets/deliveries/release-report/asset.bin`,
    "GET", undefined, 200), asset);
  await api(`/documents/${selected.id}`, "PUT", { markdown: "更新后稿件", baseRevision: (await api(`/documents/${selected.id}`)).revision });
  assert.equal((await readShare()).document.markdown, ship);
  console.log("Passed docs CLI delivery, identical retry, immutable anonymous release and attachment");

  git(work, "init", "-q", "--bare", repo);
  git(work, "init", "-q", "--initial-branch=main", site);
  mkdirSync(join(site, "templates"), { recursive: true });
  writeFileSync(join(site, "zola.toml"), "base_url = 'https://blog.example.test'\n");
  for (const template of ["article.html", "page.html"]) {
    writeFileSync(join(site, "templates", template), "{{ page.content | safe }}");
  }
  writeFileSync(join(site, "templates/section.html"),
    "{% for page in section.pages %}{{ page.title }}{% endfor %}");
  git(site, "add", "--", ".");
  git(site, "-c", "user.name=Release", "-c", "user.email=release@example.test", "commit", "-qm", "Initial site");
  git(work, "clone", "-q", "--bare", site, target);
  const writeTargets = (name, targets) => writeFileSync(join(root, ".librarian", name), JSON.stringify({ targets }));
  writeTargets("backup-targets.json", [{ id: "local", label: "Local", workspaceId: id, repository: repo, branch: "archive" }]);
  writeTargets("publication-targets.json", [{
    id: "blog", label: "Local blog", workspaceId: id, repository: target, branch: "main",
    contentPath: "content/articles", template: "article.html", baseUrl: "https://blog.example.test",
  }]);
  await api(`${base}/backup`, "PUT", { targetId: "local", mode: "grouped" });
  const runBackup = { operationId: randomUUID() };
  const backup = await api(`${base}/backup/jobs`, "POST", runBackup, 202);
  assert.equal(backup.status, "succeeded", backup.message);
  assert.equal(git(repo, "rev-parse", "refs/heads/archive").toString().trim(), backup.commitId);
  assert.deepEqual(await api(`${base}/backup/jobs`, "POST", runBackup, 202), backup);
  const plan = { workspaceId: id, targetId: "blog", commitId: receipt.commitId, documentIds: [selected.id], operationId: randomUUID() };
  const pending = await api("/publications", "POST", plan, 201);
  assert.equal(pending.status, "pending");
  const publication = await api(`/publications/${pending.id}/confirm`, "POST");
  assert.equal(publication.status, "published", publication.message);
  assert.equal(git(target, "rev-parse", "refs/heads/main").toString().trim(), publication.publishedCommitId);
  assert.equal(publication.url, "https://blog.example.test/articles/report/");
  console.log("Passed exact Git backup and explicitly confirmed Zola build and release");

  await app.stop();
  app = undefined;
  const archive = join(work, "data.tar.gz");
  const restore = join(work, "restore");
  mkdirSync(restore);
  command("tar", ["-C", root, "-czf", archive, "."]);
  command("tar", ["-C", restore, "-xzf", archive]);
  app = await launch(librarian, restore);
  await heartbeat(app.origin, join(restore, ".librarian/managed-runner.json"));
  const restored = await login(app.origin);
  assert.equal((await restored(firstPath)).markdown, first.markdown);
  assert.equal((await readShare()).document.markdown, ship);
  assert.deepEqual((await restored(`${base}/backup`)).lastJob, backup);
  assert.deepEqual(await restored(`/publications/${publication.id}`), publication);
  await restored(snapshotPath, "DELETE", undefined, 204);
  await request(app.origin, snapshotPath, "GET", undefined, 404);
  await restored("/session/logout", "POST", undefined, 204);
  await restored("/session", "GET", undefined, 401);
  console.log("Passed offline data-root export, isolated restart, restore, share revocation and browser logout");

  if (process.env.LIBRARIAN_PREVIOUS_BINARY) {
    await app.stop();
    app = undefined;
    const oldRoot = join(work, "previous");
    const previous = resolve(process.env.LIBRARIAN_PREVIOUS_BINARY);
    // Very early releases predate the standalone init command.
    const initializer = /\binit\b/.test(command(previous, ["--help"]).toString()) ? previous : librarian;
    initialize(oldRoot, initializer);
    const native = join(oldRoot, "spaces/legacy");
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "Legacy.md"), note);
    writeFileSync(join(oldRoot, "spaces.json"), JSON.stringify({
      legacy: {
        name: "旧工作区", access: "none", binding: { prefix: "/legacy" }, revisions: "managed",
        revisionsCommit: { quietSecs: 5, maxIntervalSecs: 5 },
      },
    }));
    app = await launch(previous, oldRoot);
    const oldApi = await login(app.origin);
    const oldSpace = (await oldApi("/workspaces"))[0];
    const oldDeliveryPath = `/workspaces/${oldSpace.id}/delivery-tokens`;
    const oldGrant = process.env.LIBRARIAN_PREVIOUS_UNSCOPED_TOKENS === "1"
      ? await oldApi(oldDeliveryPath, "POST", { name: "Unscoped stage 4 credential" }, 201)
      : undefined;
    const oldDoc = (await oldApi(`/workspaces/${oldSpace.id}/documents`))[0];
    const legacyDeliveryId = "retained-legacy-delivery";
    const oldReceipt = oldGrant ? push(oldSpace.id, legacyDeliveryId, oldGrant.token) : undefined;
    const oldWritten = await oldApi(`/workspaces/${oldSpace.id}/documents`, "POST", {
      path: "Persistent.md", markdown: note, baseRevision: null,
    }, 201);
    const revisionRoute = `/documents/${oldWritten.document.id}/revisions`;
    let olderCommit;
    for (let attempt = 0; attempt < 30 && !olderCommit; attempt += 1) {
      olderCommit = (await oldApi(revisionRoute)).revisions[0]?.commitId;
      if (!olderCommit) await wait(350);
    }
    assert.match(olderCommit, complete);
    await app.stop();
    const beforeUpgrade = join(work, "before-upgrade.tar.gz");
    command("tar", ["-czf", beforeUpgrade, "-C", oldRoot, "."]);
    const upgradedIdentity = checkRunnerInstall(distribution, oldRoot, join(work, "upgrade units"));
    app = await launch(librarian, oldRoot);
    await heartbeat(app.origin, upgradedIdentity);
    const upgraded = await login(app.origin);
    assert.equal((await upgraded("/ai/settings")).dispatchMode, "legacy");
    assert.equal((await upgraded("/workspaces"))[0].id, oldSpace.id);
    assert.equal((await upgraded(`/documents/${oldDoc.id}`)).markdown, note);
    assert.equal((await upgraded(revisionRoute)).revisions[0].commitId, olderCommit);
    assert.equal((await upgraded(`/workspaces/${oldSpace.id}/backup`)).mode, "grouped");
    if (oldGrant) {
      const [migrated] = await upgraded(oldDeliveryPath);
      assert.equal(migrated.id, oldGrant.id);
      assert.equal(migrated.deliveryId, null);
      assert.equal(migrated.revoked, true);
      const rejected = await fetch(`${app.origin}/api/v1/workspaces/${oldSpace.id}/deliveries`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${oldGrant.token}` },
        body: JSON.stringify({
          manifest: { deliveryId: "legacy-test", sourceName: "Local upgrade smoke" },
          files: [{ path: "LegacyContact.md", contentBase64: Buffer.from(note).toString("base64") }],
        }),
      });
      assert.equal(rejected.status, 401);
      const replacement = await upgraded(oldDeliveryPath, "POST", {
        name: "Scoped replacement credential", deliveryId: legacyDeliveryId,
      }, 201);
      assert.deepEqual(push(oldSpace.id, legacyDeliveryId, replacement.token), oldReceipt);
      console.log("Passed prior-schema delivery credential retirement and receipt preservation");
    }
    await app.stop();
    app = undefined;
    const rollback = join(work, "rollback");
    mkdirSync(rollback);
    command("tar", ["-xzf", beforeUpgrade, "-C", rollback]);
    app = await launch(previous, rollback);
    const rolledBack = await login(app.origin);
    assert.equal((await rolledBack("/workspaces"))[0].id, oldSpace.id);
    assert.equal((await rolledBack(`/documents/${oldWritten.document.id}`)).markdown, note);
    assert.equal((await rolledBack(revisionRoute)).revisions[0].commitId, olderCommit);
    if (oldGrant) assert.equal((await rolledBack(oldDeliveryPath))[0].id, oldGrant.id);
    console.log("Passed prior-binary upgrade and rollback from a pre-upgrade backup, with stable document ID and Git revision");
    console.log(`Previous binary SHA-256 ${createHash("sha256").update(readFileSync(previous)).digest("hex")}`);
  } else {
    console.log("Previous-binary upgrade skipped. Set LIBRARIAN_PREVIOUS_BINARY to include it.");
  }
  console.log("Release journey passed");
} finally {
  await app?.stop();
  if (model?.listening) await new Promise((resolve) => model.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
