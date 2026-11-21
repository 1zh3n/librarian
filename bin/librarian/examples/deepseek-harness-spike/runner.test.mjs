import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { provider } from "./model-fixture.mjs";

const fixture = process.env.LIBRARIAN_READER_FIXTURE;
const runnerToken = "reader-fixture-ai-token-only-for-tests";
const modelKey = "local-only-model-key";
const model = "deepseek-flash";
const execFileAsync = promisify(execFile);
const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));

async function session(origin, username = "reader") {
  const login = await fetch(`${origin}/.auth/librarian/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin },
    body: new URLSearchParams({ username, password: `${username}-test-password` }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return async (route, method = "GET", body, expected = 200) => {
    const response = await fetch(`${origin}/api/v1${route}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected, `${method} ${route}`);
    return response.status === 204 ? null : response.json();
  };
}

function lastTool(request) {
  const result = request.body.messages
    .flatMap(({ content }) => content)
    .findLast(({ type }) => type === "tool_result");
  assert.equal(result.is_error, false, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test(
  "isolated Librarian service with the official external Harness runner",
  { skip: !fixture && "Set LIBRARIAN_READER_FIXTURE" },
  async (t) => {
    const portPicker = createServer();
    portPicker.listen(0, "127.0.0.1");
    await once(portPicker, "listening");
    const port = portPicker.address().port;
    await new Promise((resolve) => portPicker.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(fixture, [String(port)], { stdio: "ignore" });
    const exited = once(child, "close");
    exited.catch(() => {});
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGINT");
      await exited;
    });
    for (let attempt = 0; ; attempt += 1) {
      const health = await fetch(`${origin}/api/v1/health`).catch(() => null);
      if (health?.ok) break;
      assert.ok(attempt < 100 && child.exitCode === null, "fixture starts");
      await sleep(40);
    }
    const { runOnce } = await import("./runner.mjs");
    const ui =
      process.env.LIBRARIAN_SPIKE_BROWSER === "1" ? await import("@playwright/test") : undefined;
    const browser = await ui?.chromium.launch();
    if (browser) t.after(() => browser.close());
    async function openReader(t, username, path) {
      const page = await browser.newPage({ baseURL: origin });
      page.setDefaultTimeout(5_000);
      t.after(() => page.close());
      const login = await page.request.post("/.auth/librarian/login", {
        maxRedirects: 0,
        headers: { origin },
        form: { username, password: `${username}-test-password` },
      });
      assert.equal(login.status(), 303);
      await page.goto(path);
      return page;
    }
    const api = await session(origin);
    const admin = await session(origin, "fixture-admin");
    const reader = await session(origin, "offline-reader");
    const workspaces = await api("/workspaces");
    const workspace = workspaces.find(({ name }) => name === "田野笔记");
    const other = workspaces.find(({ name }) => name === "另一空间");
    const documents = await api(`/workspaces/${workspace.id}/documents`);
    const [first, second] = ["野外/01.md", "野外/02.md"].map((path) =>
      documents.find((doc) => doc.path === path),
    );
    const [outside] = await api(`/workspaces/${other.id}/documents`);
    const read = (doc) => api(`/documents/${doc.id}`);
    const start = (mode, prompt, documentId = null, context = [], as = api, expected = 202) =>
      as(
        "/ai/operations",
        "POST",
        { workspaceId: workspace.id, documentId, mode, prompt, context },
        expected,
      );
    const route = (op) => `/ai/operations/${op.id}`;
    const execute = (provider, settings) =>
      runOnce({
        librarianUrl: origin,
        runnerToken,
        model,
        modelKey,
        baseUrl: provider.baseUrl,
        signal: AbortSignal.timeout(5_000),
        ...settings,
      });

    await t.test("only read documents are cited and read-only members can ask", async (t) => {
      await admin(`/workspaces/${workspace.id}/members/offline-reader`, "PUT", { role: "read" });
      await start("edit", "不能修改", second.id, [], reader, 403);
      const op = await start("chat", "只读林间回声", null, [], reader);
      const original = await read(second);
      const stub = await provider(t, [
        { tool: "search_workspace", args: { query: "" } },
        (request) => {
          const { documents: hits } = lastTool(request);
          assert.deepEqual(hits.map(({ id }) => id).sort(), [first.id, second.id].sort());
          assert.ok(hits.every((hit) => !("markdown" in hit)));
          assert.ok(!hits.some(({ id }) => id === outside.id));
          assert.deepEqual(request.body.tools.map(({ name }) => name).sort(), [
            "read_document",
            "search_workspace",
          ]);
          assert.ok(!JSON.stringify(request).includes(runnerToken));
          return { tool: "read_document", args: { documentId: second.id } };
        },
        (request) => {
          const source = lastTool(request);
          assert.equal(source.revision, original.revision);
          assert.equal(source.markdown, original.markdown);
          assert.equal(source.editable, false);
          return { text: "记录写到了鸟鸣。" };
        },
      ]);
      const { stdout, stderr } = await execFileAsync(process.execPath, [runnerPath, "--once"], {
        env: {
          ...process.env,
          LIBRARIAN_URL: origin,
          LIBRARIAN_RUNNER_TOKEN: runnerToken,
          DEEPSEEK_API_KEY: modelKey,
          DEEPSEEK_MODEL: model,
          DEEPSEEK_BASE_URL: stub.baseUrl,
        },
        timeout: 8_000,
      });
      assert.equal(stderr, "");
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.rounds, 3);
      assert.equal(receipt.usage.inputTokens, 60);
      t.diagnostic(JSON.stringify(receipt));
      const result = await reader(route(op));
      assert.equal(result.status, "succeeded");
      assert.equal(result.commitId, null);
      assert.deepEqual(
        result.sources.map(({ documentId }) => documentId),
        [second.id],
      );
      assert.equal((await read(second)).revision, original.revision);
      if (ui) {
        const page = await openReader(t, "offline-reader", `/workspaces/${workspace.id}/ai`);
        const citations = page.getByRole("list", { name: "引用来源" });
        await ui.expect(citations.getByRole("link")).toHaveCount(1);
        await ui
          .expect(citations.getByRole("link", { name: second.path }))
          .toHaveAttribute("href", `/workspaces/${workspace.id}/documents/${second.id}`);
      }
    });

    await t.test(
      "selection and outline survive transport, an uncertain response retries, and undo restores bytes",
      async (t) => {
        const original = await read(second);
        const outline = await api(`/documents/${second.id}/outline`);
        const selection = "鸟鸣";
        const from = original.markdown.indexOf(selection);
        const op = await start("edit", "将鸟鸣改为鸟叫，其他内容保持原样。", second.id, [
          { documentId: second.id, revision: original.revision, from, to: from + selection.length },
        ]);
        const edited = original.markdown.replace(selection, "鸟叫");
        const submissions = [];
        const proxy = await listen(
          t,
          createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = Buffer.concat(chunks).toString();
            const result = await fetch(`${origin}${request.url}`, {
              method: request.method,
              headers: {
                authorization: request.headers.authorization,
                "content-type": "application/json",
              },
              body: body || undefined,
            });
            const payload = await result.text();
            if (request.method === "PUT" && request.url.endsWith("/result")) {
              submissions.push({ body, status: result.status });
              if (submissions.length === 1) return response.destroy();
            }
            response.writeHead(result.status, { "content-type": "application/json" }).end(payload);
          }),
        );
        const stub = await provider(t, [
          (request) => {
            const input = JSON.parse(request.body.messages.at(-1).content[0].text);
            assert.equal(input.sources[0].markdown, selection);
            assert.equal(input.sources[0].revision, original.revision);
            assert.equal(input.sources[0].from, from);
            assert.equal(input.sources[0].editable, false);
            assert.equal(input.sources[1].markdown, outline.markdown);
            return { tool: "read_document", args: { documentId: second.id, full: true } };
          },
          (request) => {
            const source = lastTool(request);
            assert.equal(source.markdown, original.markdown);
            assert.equal(source.editable, true);
            return {
              tool: "submit_document_edits",
              args: { sourceId: source.sourceId, markdown: edited },
            };
          },
          { text: "已修订。" },
        ]);
        t.diagnostic(JSON.stringify(await execute(stub, { librarianUrl: proxy })));
        assert.equal(submissions.length, 2);
        assert.deepEqual(submissions[0], submissions[1]);
        assert.equal(submissions[0].status, 200);
        const result = await api(route(op));
        assert.equal(result.status, "succeeded");
        assert.match(result.commitId, /^[0-9a-f]{40}$/);
        const history = await api(`/documents/${second.id}/revisions`);
        assert.equal(
          history.revisions.filter(({ commitId }) => commitId === result.commitId).length,
          1,
        );
        const diff = await api(`${route(op)}/diff?${new URLSearchParams({ path: second.path })}`);
        assert.match(diff.diff, /\+清晨听见鸟叫。/);
        assert.equal((await read(second)).markdown, edited);
        if (ui) {
          const page = await openReader(
            t,
            "reader",
            `/workspaces/${workspace.id}/documents/${second.id}`,
          );
          await ui.expect(page.getByRole("article")).toContainText("清晨听见鸟叫。");
          const open = page.getByRole("button", { name: "打开文档辅助区" });
          if (await open.isVisible()) await open.click();
          await page.getByRole("tab", { name: "AI", exact: true }).click();
          await page.getByRole("button", { name: "查看改动" }).click();
          await page
            .getByRole("region", { name: "AI 改动" })
            .getByRole("button", { name: second.path })
            .click();
          await ui.expect(page.getByLabel("版本差异")).toContainText("+清晨听见鸟叫。");
          await page.getByRole("button", { name: "撤销", exact: true }).click();
          await ui.expect(page.getByRole("article")).toContainText("清晨听见鸟鸣。");
        } else {
          await api(`${route(op)}/undo`, "POST", {});
        }
        assert.deepEqual(
          Buffer.from((await read(second)).markdown),
          Buffer.from(original.markdown),
        );
      },
    );

    await t.test("unknown source ID cannot write and produces a failed operation", async (t) => {
      const original = await read(second);
      const op = await start("edit", "修改第二篇。", second.id);
      const stub = await provider(t, [
        { tool: "submit_document_edits", args: { sourceId: "invented", markdown: "未授权内容。" } },
        { text: "任务失败。" },
      ]);
      await assert.rejects(execute(stub), { code: "UNREAD_SOURCE" });
      const result = await api(route(op));
      assert.equal(result.status, "failed");
      assert.equal(result.commitId, null);
      assert.equal((await read(second)).revision, original.revision);
    });

    await t.test("a provider which hangs returns a timeout and creates no revision", async (t) => {
      const original = await read(second);
      const op = await start("edit", "修改第二篇。", second.id);
      const stub = await provider(t, [{ hang: true }]);
      await assert.rejects(execute(stub, { modelTimeout: 250 }), { code: "MODEL_TIMEOUT" });
      assert.equal(stub.requests.length, 1);
      const result = await api(route(op));
      assert.equal(result.status, "failed");
      assert.equal(result.commitId, null);
      assert.equal((await read(second)).revision, original.revision);
    });

    await t.test("a newer manual revision wins over staged output", async (t) => {
      const original = await read(second);
      const op = await start("edit", "修改第二篇。", second.id);
      const manual = `${original.markdown}\n保留人工更新。\n`;
      const stub = await provider(t, [
        async (request) => {
          const task = JSON.parse(request.body.messages.at(-1).content[0].text);
          await api(`/documents/${second.id}`, "PUT", {
            baseRevision: original.revision,
            markdown: manual,
          });
          return {
            tool: "submit_document_edits",
            args: { sourceId: task.sources[0].sourceId, markdown: "模型低版本。" },
          };
        },
        { text: "已暂存。" },
      ]);
      await assert.rejects(execute(stub), { code: "revision_conflict" });
      const result = await api(route(op));
      assert.equal(result.status, "conflict");
      assert.equal(result.commitId, null);
      assert.equal((await read(second)).markdown, manual);
    });

    await t.test(
      "revoking write rights while the model runs prevents its staged update",
      async (t) => {
        const original = await read(second);
        const membership = `/workspaces/${workspace.id}/members/offline-reader`;
        await admin(membership, "PUT", { role: "write" });
        const op = await start("edit", "修改第二篇。", second.id, [], reader);
        const stub = await provider(t, [
          async (request) => {
            const task = JSON.parse(request.body.messages.at(-1).content[0].text);
            await admin(membership, "PUT", { role: "read" });
            return {
              tool: "submit_document_edits",
              args: { sourceId: task.sources[0].sourceId, markdown: "权限已撤回。" },
            };
          },
          { text: "已暂存。" },
        ]);
        await assert.rejects(execute(stub), { status: 403 });
        assert.equal((await reader(route(op))).commitId, null);
        assert.equal((await read(second)).revision, original.revision);
      },
    );

    await t.test(
      "the UTF-8 budget rejects excess document data before contacting the model",
      async (t) => {
        const oversized = await api(
          `/workspaces/${workspace.id}/documents`,
          "POST",
          {
            path: "样本预算.md",
            markdown: "鸟".repeat(90_000),
            baseRevision: null,
          },
          201,
        );
        const op = await start("chat", "请概括正文。", oversized.document.id);
        const stub = await provider(t, []);
        await assert.rejects(execute(stub), { code: "SOURCE_LIMIT" });
        assert.equal(stub.requests.length, 0);
        assert.equal((await api(route(op))).status, "failed");
      },
    );

    await t.test(
      "stopping while a staged edit awaits its final answer leaves the document unchanged",
      async (t) => {
        const original = await read(second);
        const controller = new AbortController();
        const op = await start("edit", "修改第二篇。", second.id);
        const stub = await provider(t, [
          (request) => {
            const task = JSON.parse(request.body.messages.at(-1).content[0].text);
            return {
              tool: "submit_document_edits",
              args: { sourceId: task.sources[0].sourceId, markdown: "尚未写入。" },
            };
          },
          (request) => {
            assert.deepEqual(lastTool(request), { staged: true });
            controller.abort();
            return { hang: true };
          },
        ]);
        await assert.rejects(execute(stub, { signal: controller.signal }), { name: "AbortError" });
        assert.equal(stub.requests.length, 2);
        assert.equal((await api(route(op))).commitId, null);
        assert.equal((await read(second)).revision, original.revision);
      },
    );
  },
);
