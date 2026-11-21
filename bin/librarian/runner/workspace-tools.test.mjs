import assert from "node:assert/strict";
import test from "node:test";
import { ca, identity, message, provider, service, task } from "./fixtures.mjs";
import { runOnce } from "./runner.mjs";

const lease = "claims/fixture-lease/";
const material = { id: "file-a", name: "对照.pdf" };
const source = {
  id: "source-pdf", kind: "material", materialId: material.id,
  name: material.name, segmentId: "s2", page: 2, conversationId: "conversation",
};

function call(tool, args) { return { tool, args }; }
async function run(t, { mode = "chat", input, script, route }) {
  const observedWrites = [];
  let server;
  const model = await provider(t, (_, res, n) => {
    observedWrites.push(server.calls.filter(c => c.method === "PUT" || c.method === "DELETE"));
    const step = script[n - 1] ?? { text: "完成。" };
    return message(res, { ...step, toolId: "call_" + n });
  });
  server = await service(t, {
    messagesUrl: model.messagesUrl,
    claim: task("chat", { input: { workspaceId: "ws", context: [], mode, prompt: "按要求处理", ...input } }),
    override: route,
  });
  await runOnce({ librarianUrl: server.librarianUrl, identity, ca, signal: AbortSignal.timeout(12000), modelTimeout: 8000 });
  for (const writes of observedWrites) assert.deepEqual(writes, [], "files must stay unchanged throughout model calls");
  return {
    requests: model.calls.map(c => c.body),
    tools: model.calls[0]?.body.tools?.map(t => t.name) ?? [],
    calls: server.calls,
    results: server.calls.filter(c => c.route === lease + "result").map(c => c.body),
    failures: server.calls.filter(c => c.route === lease + "fail"),
  };
}

const catalogPath = lease + "materials/file-a/segments";
function materialRoute(c, _res, json) {
  if (c.route.startsWith(catalogPath + "?")) {
    json({ items: [{ segmentId: "s2", page: 2, text: "list-must-hide-this" }], nextCursor: "more" });
    return true;
  }
  if (c.route === catalogPath + "/s2") {
    json({ source, text: "实际读取片段，七十。" });
    return true;
  }
}

test("Harness searches selected material metadata, reads the requested segment and cites the service source", async t => {
  const r = await run(t, {
    input: { materials: [{ ...material, text: "do-not-preload", privatePath: "/internal/file-a.raw" }] },
    script: [
      call("list_material_segments", { materialId: material.id, query: "金额 & 预算", cursor: "24" }),
      call("read_material", { materialId: material.id, segmentId: "s2" }),
    ], route: materialRoute,
  });
  assert(r.tools.includes("list_material_segments") && r.tools.includes("read_material"));
  assert(!r.tools.includes("request_reorganization") && !r.tools.includes("create_document"));
  const initial = JSON.parse(r.requests[0].messages[0].content[0].text);
  assert.deepEqual(initial.materials, [material]);
  const list = r.calls.find(c => c.route.startsWith(catalogPath + "?"));
  const query = new URLSearchParams(list.route.split("?")[1]);
  assert.equal(query.get("q"), "金额 & 预算");
  assert.equal(query.get("cursor"), "24");
  assert.equal(list.method, "GET");
  assert.deepEqual(r.results[0].sourceIds, [source.id]);
  assert.equal(r.calls.filter(c => c.route === catalogPath + "/s2" && c.method === "GET").length, 1);
  assert(!JSON.stringify(r.requests[1]).includes("实际读取片段"));
  assert(JSON.stringify(r.requests[2]).includes("实际读取片段"));
  for (const unavailable of ["do-not-preload", "/internal/file-a.raw", "list-must-hide-this"]) {
    assert(!JSON.stringify(r.requests).includes(unavailable));
  }
});

test("unselected material IDs never reach the lease catalog or read endpoint", async t => {
  const r = await run(t, {
    input: { materials: [material] },
    script: [call("list_material_segments", { materialId: "another" }),
      call("read_material", { materialId: "another", segmentId: "s2" })],
  });
  assert(r.tools.includes("read_material"));
  assert.deepEqual(r.calls.filter(c => c.route.includes("/materials/")), []);
  assert.deepEqual(r.results[0].sourceIds, []);
  assert(JSON.stringify(r.requests[1]).includes("unavailable"));
});

test("document and material bytes use one budget before sending a tool reply to the provider", async t => {
  const r = await run(t, {
    input: { materials: [material], context: [{ documentId: "doc" }] },
    script: [call("read_material", { materialId: material.id, segmentId: "s2" })],
    route(c, res, json) {
      if (c.route === lease + "sources") {
        json({ source: { id: "doc-proof", path: "a.md", revision: "r1" }, markdown: "x".repeat(256 * 1024 - 1) });
        return true;
      }
      return materialRoute(c, res, json);
    },
  });
  assert(r.tools.includes("read_material"));
  assert.equal(r.requests.length, 1);
  assert.equal(r.failures.length, 1);
  assert.deepEqual(r.results, []);
});

test("workspace edit stages a new cited document and a revision-checked update in the same final receipt", async t => {
  const r = await run(t, {
    mode: "edit", input: { context: [{ documentId: "doc", revision: "r1" }] },
    script: [
      call("create_document", { path: "目录/索引.md", markdown: "# 索引\r\n" }),
      call("submit_document_edits", { sourceId: "source-1", markdown: "参考\r\n" }),
    ],
  });
  assert(r.tools.includes("create_document"));
  assert.deepEqual(r.results, [{ answer: "完成。", sourceIds: ["source-1"], edits: [
    { path: "目录/索引.md", baseRevision: null, markdown: "# 索引\r\n" },
    { path: "demo.md", baseRevision: "r1", markdown: "参考\r\n" },
  ] }]);
});

for (const request of [
  { kind: "move", from: "资料", to: "归档/资料" },
  { kind: "delete", documentIds: ["doc"] },
]) {
  test("workspace " + request.kind + " creates only a confirmation request", async t => {
    const r = await run(t, { mode: "edit", input: { context: [{ documentId: "doc" }] },
      script: [call("request_reorganization", request)] });
    assert(r.tools.includes("request_reorganization"));
    assert.deepEqual(r.results, [{ answer: "完成。", sourceIds: ["source-1"], edits: [], reorganization: request }]);
    assert.equal(r.calls.some(c => c.route.endsWith("/confirm")), false);
  });
}

for (const [name, script] of [
  ["outside path", [call("create_document", { path: "../side.md", markdown: "x" })]],
  ["mixed confirmation and edits", [call("request_reorganization", { kind: "move", from: "a", to: "b" }),
    call("create_document", { path: "new.md", markdown: "x" })]],
]) {
  test("workspace staging rejects " + name + " without submitting partial edits", async t => {
    const r = await run(t, { mode: "edit", script });
    assert(r.tools.includes("create_document"));
    assert.equal(r.failures.length, 1);
    assert.deepEqual(r.results, []);
  });
}
