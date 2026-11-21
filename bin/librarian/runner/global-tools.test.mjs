import assert from "node:assert/strict";
import test from "node:test";
import { ca, identity, message, provider, service, task } from "./fixtures.mjs";
import { runOnce } from "./runner.mjs";
import { prepareChat } from "./tools.mjs";

const spaces = [
  { id: "east", name: "东区", canWrite: true, canManage: true },
  { id: "west", name: "西区", canWrite: false, canManage: false },
];
const documents = spaces.map(({ id: workspaceId }) => ({
  id: workspaceId + "-note", workspaceId, path: "预算.md", title: "预算",
}));
const input = { scope: "global", mode: "chat", prompt: "比较两处预算", context: [] };
const prefix = "claims/fixture-lease/";

test("global chat reads two same-named documents and cites each workspace and version", async t => {
  const steps = [
    ["list_workspaces", {}],
    ["search_workspace", { workspaceId: "east", query: "预算" }],
    ["search_workspace", { workspaceId: "west", query: "预算" }],
    ...documents.map(d => ["read_document", { documentId: d.id }]),
  ];
  const model = await provider(t, (_call, response, n) => {
    const step = steps[n - 1];
    message(response, step
      ? { tool: step[0], args: step[1], toolId: "t" + n }
      : { text: n === steps.length + 1 ? "已核对" : "东区三十，西区七十。" });
  });
  const s = await service(t, {
    messagesUrl: model.messagesUrl, claim: task("chat", { input }),
    override(c, _res, json) {
      const url = new URL(c.route, "http://fixture/");
      if (url.pathname === "/" + prefix + "workspaces") {
        json(spaces.map(w => ({ ...w, privateMarker: "hidden-metadata" })));
      } else if (url.pathname === "/" + prefix + "documents") {
        json(documents.filter(d => d.workspaceId === url.searchParams.get("workspaceId")));
      } else if (c.route === prefix + "sources") {
        const d = documents.find(d => d.id === c.body.documentId);
        assert.equal(c.body.workspaceId, d.workspaceId);
        json({ source: { id: "ref-" + d.id, documentId: d.id, workspaceId: d.workspaceId,
          path: d.path, revision: "rev-" + d.id, workspaceName: spaces.find(w => w.id === d.workspaceId).name }, markdown: d.workspaceId === "east" ? "三十" : "七十" });
      } else return;
      return true;
    },
  });
  await runOnce({ librarianUrl: s.librarianUrl, identity, ca, signal: AbortSignal.timeout(12000) });
  assert.deepEqual(s.calls.filter(c => c.route === prefix + "result").map(c => c.body), [{
    answer: "东区三十，西区七十。", sourceIds: ["ref-east-note", "ref-west-note"], edits: [],
  }]);
  const tools = model.calls[0].body.tools.map(t => t.name).sort();
  assert.deepEqual(tools, ["list_workspaces", "read_document", "search_workspace"]);
  const results = model.calls.flatMap(c => c.body.messages.flatMap(m => m.content))
    .filter(b => b.type === "tool_result").map(b => b.content).flat();
  for (const d of documents) {
    assert(results.some(b => {
      const value = JSON.parse(b.text);
      return value.sourceId === "ref-" + d.id && value.workspaceId === d.workspaceId
        && value.workspaceName === spaces.find(w => w.id === d.workspaceId).name
        && value.documentId === d.id && value.revision === "rev-" + d.id;
    }));
  }
  assert(!JSON.stringify(model.calls).includes("hidden-metadata"));
});

test("scoped edit never registers global tools", async () => {
  const scoped = await prepareChat({ workspaceId: "east", mode: "edit", prompt: "编辑" }, async () => {}, async () => {});
  assert.deepEqual(scoped.tools.map(t => t.name).sort(), [
    "create_document", "read_document", "request_reorganization", "search_workspace", "submit_document_edits",
  ]);
});

async function globalEdit(rows = spaces) {
  const calls = [];
  const chat = await prepareChat({ ...input, mode: "edit" }, async (route, method) => {
    calls.push({ route, method });
    if (route === "workspaces") return rows;
    const url = new URL(route, "http://fixture");
    if (url.pathname === "/documents") return documents.filter(d => d.workspaceId === url.searchParams.get("workspaceId"));
    throw new Error("Unexpected direct action " + route);
  }, async () => {});
  async function invoke(name, args) {
    const definition = chat.tools.find(tool => tool.name === name);
    assert.ok(definition, "missing global tool " + name);
    return definition.execute(args);
  }
  return { chat, invoke, calls };
}

for (const action of ["move", "copy"]) {
  test("global " + action + " stages the discovered document and both named workspaces", async () => {
    const { invoke, chat, calls } = await globalEdit();
    await invoke("list_workspaces", {});
    await invoke("search_workspace", { workspaceId: "east", query: "预算" });
    await invoke("transfer_document", {
      action, documentId: "east-note", targetWorkspaceId: "west", targetPath: "整理/预算.md",
    });
    assert.deepEqual(chat.result("请核对").action, {
      kind: action, sourceWorkspaceId: "east", documentId: "east-note", sourcePath: "预算.md",
      targetWorkspaceId: "west", targetPath: "整理/预算.md",
    });
    assert(calls.every(call => call.method === "GET"));
    await assert.rejects(() => invoke("create_workspace", { name: "额外动作" }));
  });
}

for (const [tool, args, expected] of [
  ["create_workspace", { name: "首次创建" }, { kind: "create_workspace", name: "首次创建" }],
  ["rename_workspace", { workspaceId: "east", name: "新名" }, { kind: "rename_workspace", workspaceId: "east", name: "新名" }],
  ["set_workspace_member", { workspaceId: "east", username: "li", role: "read" },
    { kind: "set_workspace_member", workspaceId: "east", username: "li", role: "read" }],
  ["remove_workspace_member", { workspaceId: "east", username: "li" },
    { kind: "remove_workspace_member", workspaceId: "east", username: "li" }],
]) {
  test("global edit stages " + tool + " for the terminal server receipt", async () => {
    const { invoke, chat, calls } = await globalEdit(tool === "create_workspace" ? [] : spaces);
    await invoke("list_workspaces", {});
    await invoke(tool, args);
    assert.deepEqual(chat.result("已准备"), { answer: "已准备", sourceIds: [], edits: [], action: expected });
    assert.deepEqual(calls.map(c => c.route), ["workspaces"]);
  });
}

const list = ["list_workspaces", {}];
const search = (workspaceId) => ["search_workspace", { workspaceId, query: "预算" }];
const read = (documentId, extra = {}) => ["read_document", { documentId, ...extra }];
const create = (workspaceId) => ["create_document", { workspaceId, path: "新稿.md", markdown: "# 稿\r\n" }];
const update = ["submit_document_edits", { sourceId: "ref-east-note", markdown: "金额：三十。  \r\n" }];
const createSpace = ["create_workspace", { name: "新空间" }];

async function runEdit(t, steps, override) {
  const model = await provider(t, (_call, response, n) => {
    const step = steps[n - 1];
    return message(response, step ? { tool: step[0], args: step[1], toolId: "tool" + n } : { text: "已准备" });
  });
  const server = await service(t, {
    claim: task("chat", { input: { ...input, mode: "edit" } }), messagesUrl: model.messagesUrl,
    override(c, res, json) {
      if (override?.(c, res, json)) return true;
      if (c.route === prefix + "workspaces") json(spaces);
      else if (c.route.startsWith(prefix + "documents?")) {
        const workspace = new URLSearchParams(c.route.split("?")[1]).get("workspaceId");
        json(documents.filter(d => d.workspaceId === workspace));
      } else if (c.route === prefix + "sources") {
        const { workspaceId, documentId, outline } = c.body;
        const d = documents.find(d => d.id === documentId && d.workspaceId === workspaceId);
        if (!d) json({ code: "not_found" }, 404);
        else json({ source: {
          id: (outline ? "outline-" : "ref-") + documentId, documentId, workspaceId,
          workspaceName: spaces.find(w => w.id === workspaceId).name,
          path: outline ? "预算.outline.md" : d.path, revision: "base",
        }, markdown: "# 预算\r\n" });
      } else return;
      return true;
    },
  });
  await runOnce({ librarianUrl: server.librarianUrl, identity, ca, signal: AbortSignal.timeout(12000) });
  return {
    results: server.calls.filter(c => c.route === prefix + "result").map(c => c.body),
    failures: server.calls.filter(c => c.route === prefix + "fail").map(c => c.body),
    calls: server.calls, modelCalls: model.calls,
  };
}

test("global ordinary edits share one destination and use the service revision and exact Markdown", async t => {
  const { results, failures } = await runEdit(t, [list, search("east"), read("east-note"), update, create("east")]);
  assert.deepEqual(failures, []);
  assert.deepEqual(results, [{
    answer: "已准备", sourceIds: ["ref-east-note"], targetWorkspaceId: "east", edits: [
      { path: "预算.md", baseRevision: "base", markdown: update[1].markdown },
      { path: "新稿.md", baseRevision: null, markdown: create("east")[1].markdown },
    ],
  }]);
});

test("an unchanged global replacement produces a read-only receipt with no destination", async t => {
  const { results } = await runEdit(t, [list, search("east"), read("east-note"),
    ["submit_document_edits", { sourceId: "ref-east-note", markdown: "# 预算\r\n" }]]);
  assert.deepEqual(results, [{ answer: "已准备", sourceIds: ["ref-east-note"], edits: [] }]);
});

for (const [name, steps] of [
  ["edits in multiple workspaces", [list, create("east"), create("west")]],
  ["action following an edit", [list, create("east"), createSpace]],
  ["edit following an action", [list, createSpace, create("east")]],
  ["two actions", [list, createSpace, createSpace]],
  ["undiscovered update", [list, update]],
  ["unlisted destination", [list, create("unknown")]],
]) {
  test("global edit rejects " + name + " before any terminal write", async t => {
    const { results, failures, modelCalls } = await runEdit(t, steps);
    assert.deepEqual(results, []);
    assert.equal(failures.length, 1);
    assert.equal(modelCalls.length, steps.length);
    if (name.includes("action") || name.includes("multiple workspaces")) {
      assert.match(failures[0].text, /分开|单独|同一/);
    }
  });
}

test("a repeated read after revocation checks the lease again and cancels pending edits", async t => {
  let reads = 0;
  const { results, failures } = await runEdit(t, [list, search("east"), read("east-note"), create("west"), read("east-note")],
    (c, _res, json) => {
      if (c.route === prefix + "sources" && ++reads === 2) {
        json({ code: "not_found" }, 404);
        return true;
      }
    });
  assert.equal(reads, 2);
  assert.deepEqual(results, []);
  assert.equal(failures.length, 1);
});

test("transfer after an outline read uses the original document path", async t => {
  const { results } = await runEdit(t, [list, search("east"), read("east-note", { outline: true }),
    ["transfer_document", { action: "copy", documentId: "east-note", targetWorkspaceId: "west", targetPath: "副本.md" }]]);
  assert.equal(results[0]?.action?.sourcePath, "预算.md");
});

for (const action of ["move", "copy"]) {
  test("the " + action + " folder receipt binds both full paths and distinct workspaces", async t => {
    const paths = { sourceWorkspaceId: "east", sourcePath: "资料", targetWorkspaceId: "west", targetPath: "归档/资料" };
    const { results } = await runEdit(t, [list, ["transfer_folder", { action, ...paths }]]);
    assert.deepEqual(results, [{ answer: "已准备", sourceIds: [], edits: [], action: { kind: action, sourceKind: "folder", ...paths } }]);
  });
}

test("a global destination name conflict closes the lease with an actionable failure", async t => {
  const { results, failures } = await runEdit(t, [list, create("east")], (c, _res, json) => {
    if (c.route === prefix + "result") {
      json({ code: "path_exists" }, 409);
      return true;
    }
  });
  assert.equal(results[0]?.targetWorkspaceId, "east");
  assert.equal(failures.length, 1);
  assert.match(failures[0].text, /路径|同名/);
});

test("a management permission revoked after discovery rejects the exact staged terminal action", async t => {
  const rename = ["rename_workspace", { workspaceId: "east", name: "更名" }];
  const { results, failures, calls } = await runEdit(t, [list, rename], (c, _res, json) => {
    if (c.route === prefix + "result") {
      json({ code: "workspace_manage_required" }, 403);
      return true;
    }
  });
  assert.deepEqual(results, [{
    answer: "已准备", edits: [], sourceIds: [],
    action: { kind: "rename_workspace", workspaceId: "east", name: "更名" },
  }]);
  assert.match(failures[0]?.text, /权限/);
  assert(calls.every(c => c.route === "heartbeat" || c.route === "claims" || c.route.startsWith(prefix)));
});

test("a source returned for another workspace never enters the model or its receipt", async t => {
  const { modelCalls, results, failures } = await runEdit(t, [list, search("east"), read("east-note")],
    (c, _res, json) => {
      if (c.route === prefix + "sources") {
        json({ source: { id: "crossed", documentId: "east-note", workspaceId: "west", workspaceName: "西区",
          path: "预算.md", revision: "base" }, markdown: "wrong-workspace-content" });
        return true;
      }
    });
  assert.deepEqual(results, []);
  assert.equal(failures.length, 1);
  assert(!JSON.stringify(modelCalls).includes("wrong-workspace-content"));
});

test("unlisted workspaces and undiscovered document IDs cannot initiate reads", async () => {
  const { invoke, calls } = await globalEdit();
  await invoke("list_workspaces", {});
  assert.deepEqual(await invoke("search_workspace", { workspaceId: "unknown", query: "" }), { unavailable: true });
  assert.deepEqual(await invoke("read_document", { documentId: "east-note" }), { unavailable: true });
  assert.deepEqual(calls, [{ route: "workspaces", method: "GET" }]);
});

test("folder staging requires two listed workspaces and explicit relative folder paths", async () => {
  const { invoke, chat } = await globalEdit();
  await invoke("list_workspaces", {});
  const transfer = { action: "move", sourceWorkspaceId: "east", sourcePath: "资料", targetWorkspaceId: "west", targetPath: "归档" };
  for (const invalid of [{ sourcePath: "" }, { targetPath: "../外部" }, { targetWorkspaceId: "east" },
    { sourceWorkspaceId: "hidden" }, { targetWorkspaceId: "hidden" }]) {
    await assert.rejects(() => invoke("transfer_folder", { ...transfer, ...invalid }));
  }
  assert.deepEqual(chat.result(""), { answer: "", sourceIds: [], edits: [] });
});

test("a staged global write and a scoped-only tool call cannot commit a partial result", async t => {
  const { results, failures } = await runEdit(t, [list, create("east"),
    ["request_reorganization", { kind: "delete", documentIds: ["east-note"] }]]);
  assert.deepEqual(results, []);
  assert.equal(failures.length, 1);
});
