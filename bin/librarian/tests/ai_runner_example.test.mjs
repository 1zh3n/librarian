import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const origin = "http://127.0.0.1:46185";
const runnerPath = fileURLToPath(
  new URL("../examples/ai_runner.mjs", import.meta.url),
);
const fixture =
  process.env.LIBRARIAN_READER_FIXTURE ??
  "target/debug/examples/reader_fixture";
const runnerToken = "reader-fixture-ai-token-only-for-tests";
const modelKey = "local-model-key-for-tests";

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    log += chunk;
  });
  const exited = once(child, "close");
  // The test which owns the process reports startup errors through this promise.
  exited.catch(() => {});
  return { child, exited, log: () => log };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${origin}/api/v1/health`).catch(
      () => undefined,
    );
    if (response?.ok) {
      await response.body.cancel();
      return;
    }
    await sleep(50);
  }
  assert.fail("Librarian fixture did not start");
}

async function productSession() {
  const login = await fetch(`${origin}/.auth/librarian/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin },
    body: new URLSearchParams({
      username: "reader",
      password: "reader-test-password",
    }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return async (path, method = "GET", body, status = 200) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
}

test("the external runner completes operations through a native Librarian Space", async (t) => {
  const server = startProcess(fixture, ["46185"]);
  t.after(async () => {
    if (server.child.exitCode === null) server.child.kill("SIGINT");
    await server.exited;
  });
  await Promise.race([
    waitForServer(),
    server.exited.then(() =>
      assert.fail(`Librarian fixture exited: ${server.log()}`),
    ),
  ]);
  const api = await productSession();
  const workspace = (await api("/workspaces")).find(
    (space) => space.name === "田野笔记",
  );
  const documents = await api(`/workspaces/${workspace.id}/documents`);
  const first = documents.find((doc) => doc.path === "野外/01.md");
  const second = documents.find((doc) => doc.path === "野外/02.md");
  const read = (doc) => api(`/documents/${doc.id}`);
  const start = (mode, prompt, documentId, context = []) =>
    api(
      "/ai/operations",
      "POST",
      { workspaceId: workspace.id, documentId, mode, prompt, context },
      202,
    );
  const status = (operation) => api(`/ai/operations/${operation.id}`);

  let modelReply;
  let mockError;
  const model = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, `Bearer ${modelKey}`);
      assert.equal(req.headers.cookie, undefined);
      let request = "";
      req.setEncoding("utf8");
      for await (const chunk of req) request += chunk;
      assert.ok(!request.includes(runnerToken));
      const { model: requestedModel, messages } = JSON.parse(request);
      assert.equal(requestedModel, "local-smoke-model");
      assert.equal(messages[0].role, "system");
      const transcript = messages
        .slice(1)
        .filter((message) => message.role === "user");
      const answer = await modelReply(
        transcript.map((message) => JSON.parse(message.content)),
      );
      if (answer === 503) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-smoke",
          object: "chat.completion",
          created: 1,
          model: "local-smoke-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(answer) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    } catch (error) {
      mockError = error;
      res.writeHead(400).end();
    }
  });
  model.listen(46186, "127.0.0.1");
  await once(model, "listening");
  t.after(() => new Promise((resolve) => model.close(resolve)));

  async function runOnce(
    reply,
    { expectedExit = 0, librarianUrl = origin } = {},
  ) {
    modelReply = reply;
    mockError = undefined;
    const runner = startProcess(process.execPath, [runnerPath, "--once"], {
      env: {
        ...process.env,
        LIBRARIAN_URL: librarianUrl,
        LIBRARIAN_RUNNER_TOKEN: runnerToken,
        OPENAI_BASE_URL: "http://127.0.0.1:46186/v1",
        OPENAI_API_KEY: modelKey,
        OPENAI_MODEL: "local-smoke-model",
      },
    });
    const timeout = setTimeout(() => runner.child.kill(), 15_000);
    const [code] = await runner.exited.finally(() => clearTimeout(timeout));
    assert.ifError(mockError);
    assert.ok(!runner.log().includes(runnerToken));
    assert.ok(!runner.log().includes(modelKey));
    assert.equal(code, expectedExit, runner.log());
  }

  await t.test(
    "reads default Markdown and outline for chat after a provider interruption",
    async () => {
      const before = await read(second);
      const outline = await api(`/documents/${second.id}/outline`);
      const operation = await start(
        "chat",
        "正文和自由提纲里提到了什么？",
        second.id,
      );
      let calls = 0;
      await runOnce(([task]) => {
        calls += 1;
        if (calls === 1) return 503;
        assert.equal(task.prompt, "正文和自由提纲里提到了什么？");
        assert.equal(task.mode, "chat");
        assert.deepEqual(
          task.sources.map((source) => source.markdown),
          [before.markdown, outline.markdown],
        );
        assert.ok(task.sources.every((source) => !source.editable));
        return { action: "finish", answer: "正文和自由提纲都提到了鸟鸣。" };
      });
      assert.equal(calls, 2);
      const result = await status(operation);
      assert.equal(result.status, "succeeded");
      assert.equal(result.answer, "正文和自由提纲都提到了鸟鸣。");
      assert.deepEqual(
        result.sources.map((source) => source.path),
        ["野外/02.md", "野外/02.outline.md"],
      );
      assert.equal(result.commitId, null);
      assert.equal((await read(second)).revision, before.revision);
    },
  );

  await t.test(
    "commits two files once even when the submit response is lost",
    async (t) => {
      const submitted = [];
      const proxy = createServer(async (req, res) => {
        try {
          let body = "";
          req.setEncoding("utf8");
          for await (const chunk of req) body += chunk;
          const response = await fetch(`${origin}${req.url}`, {
            method: req.method,
            headers: {
              authorization: req.headers.authorization,
              "content-type": "application/json",
            },
            body: body || undefined,
          });
          const payload = await response.text();
          if (req.method === "PUT" && req.url.endsWith("/result")) {
            submitted.push({ body, status: response.status });
            if (submitted.length === 1) {
              res.destroy();
              return;
            }
          }
          res
            .writeHead(response.status, { "content-type": "application/json" })
            .end(payload);
        } catch {
          res.writeHead(502).end();
        }
      });
      proxy.listen(46187, "127.0.0.1");
      await once(proxy, "listening");
      t.after(() => new Promise((resolve) => proxy.close(resolve)));

      const before = await Promise.all([read(first), read(second)]);
      const selected = "湿地观察";
      const from = before[0].markdown.indexOf(selected);
      const context = [
        {
          documentId: first.id,
          revision: before[0].revision,
          from,
          to: from + selected.length,
        },
      ];
      const operation = await start(
        "edit",
        "修订选区并给林间回声补充一段。",
        first.id,
        context,
      );
      const after = [
        before[0].markdown.replace(selected, "湿地观测"),
        `${before[1].markdown}\n继续补记。\n`,
      ];
      await runOnce(
        (transcript) => {
          if (transcript.length === 1) {
            assert.equal(transcript[0].sources[0].markdown, selected);
            assert.equal(transcript[0].sources[0].editable, false);
            return { action: "search", query: "林间回声" };
          }
          if (transcript.length === 2) {
            assert.equal(transcript[1].documents[0].id, second.id);
            assert.ok(
              transcript[1].documents.every(
                (doc) => !Object.hasOwn(doc, "markdown"),
              ),
            );
            return {
              action: "read",
              documents: [
                { documentId: first.id, full: true },
                { documentId: second.id },
              ],
            };
          }
          const sources = transcript[2].sources;
          assert.deepEqual(
            sources.map((source) => source.markdown),
            before.map((snapshot) => snapshot.markdown),
          );
          assert.ok(sources.every((source) => source.editable));
          assert.notEqual(
            sources[0].sourceId,
            transcript[0].sources[0].sourceId,
          );
          return {
            action: "finish",
            answer: "修订完成。",
            edits: sources.map((source, index) => ({
              sourceId: source.sourceId,
              markdown: after[index],
            })),
          };
        },
        { librarianUrl: "http://127.0.0.1:46187" },
      );
      assert.equal(submitted.length, 2);
      assert.equal(submitted[0].status, 200);
      assert.deepEqual(submitted[0], submitted[1]);
      const result = await status(operation);
      assert.equal(result.status, "succeeded");
      assert.match(result.commitId, /^[0-9a-f]{40}$/);
      assert.equal(result.changes.length, 2);
      assert.deepEqual(
        result.sources.map((source) => source.path),
        ["野外/01.md", "野外/01.md", "野外/02.md"],
      );
      for (const [index, doc] of [first, second].entries()) {
        assert.equal((await read(doc)).markdown, after[index]);
        const history = await api(`/documents/${doc.id}/revisions`);
        assert.equal(history.revisions[0].commitId, result.commitId);
      }
      const diff = await api(
        `/ai/operations/${operation.id}/diff?${new URLSearchParams({ path: first.path })}`,
      );
      assert.equal(diff.commitId, result.commitId);
      assert.ok(diff.diff.includes("+## 湿地观测"));
      const undone = await api(
        `/ai/operations/${operation.id}/undo`,
        "POST",
        {},
      );
      assert.match(undone.commitId, /^[0-9a-f]{40}$/);
      assert.notEqual(undone.commitId, result.commitId);
      assert.deepEqual(
        (await Promise.all([read(first), read(second)])).map(
          (doc) => doc.markdown,
        ),
        before.map((doc) => doc.markdown),
      );
    },
  );

  await t.test(
    "invalid model edit cannot introduce an unread file or echo provider output",
    async () => {
      const before = await read(first);
      const operation = await start("edit", "修改正文", first.id);
      const marker = "MODEL_TEXT_MUST_NOT_ESCAPE_FAILURE";
      await runOnce(
        () => ({
          action: "finish",
          answer: marker,
          edits: [{ sourceId: "invented", markdown: marker }],
        }),
        { expectedExit: 1 },
      );
      const result = await status(operation);
      assert.equal(result.status, "failed");
      assert.equal(result.commitId, null);
      assert.ok(!JSON.stringify(result).includes(marker));
      assert.equal((await read(first)).revision, before.revision);
    },
  );

  await t.test(
    "a newer manual save wins over an edit based on an earlier read",
    async () => {
      const before = await read(first);
      const operation = await start("edit", "修改正文", first.id);
      const manual = `${before.markdown}\n保留这段人工写入。\n`;
      await runOnce(async ([task]) => {
        assert.equal(task.sources[0].markdown, before.markdown);
        await api(`/documents/${first.id}`, "PUT", {
          baseRevision: before.revision,
          markdown: manual,
        });
        return {
          action: "finish",
          answer: "修订完成。",
          edits: [
            { sourceId: task.sources[0].sourceId, markdown: "模型修改。\n" },
          ],
        };
      });
      const result = await status(operation);
      assert.equal(result.status, "conflict");
      assert.equal(result.commitId, null);
      assert.equal((await read(first)).markdown, manual);
    },
  );
});
