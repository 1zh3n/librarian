import assert from "node:assert/strict";
import test from "node:test";
import { ca, identity, message, modelKey, provider, service, task, until } from "./fixtures.mjs";

async function execute(server, options) {
  const { runOnce } = await import("./runner.mjs");
  return runOnce({ librarianUrl: server.librarianUrl, identity, ca, signal: AbortSignal.timeout(8000), ...options });
}
const matching = (s, suffix) => s.calls.filter(({ route }) => route.endsWith("/" + suffix));
const events = (s) => matching(s, "events").map(({ body }) => body);
const toolsOf = (body) => body.tools?.map(({ name }) => name).sort();
const thoughts = { thought: "synthetic-private-thought", signature: "synthetic-private-signature" };

test("idle managed instance heartbeats and only polls v2", async (t) => {
  const s = await service(t, {});
  await execute(s);
  assert.deepEqual(s.calls.map(({ route, method }) => [method, route]), [["POST", "heartbeat"], ["POST", "claims"]]);
});

test("chat replays current thinking, isolates historical input and streams only final visible text before EOF", async (t) => {
  let s;
  const p = await provider(t, (call, res, n) => {
    if (n === 1) return message(res, { ...thoughts, tool: "search_workspace", args: { query: "合成" } });
    if (n === 2) return message(res, { ...thoughts, tool: "read_document", args: { documentId: "doc" } });
    if (n === 3) return message(res, { ...thoughts, text: "private-tool-phase" });
    return message(res, { ...thoughts, text: "中文回答", beforeEnd: () => until(() => events(s).some(e => e.text === "中文回答")) });
  });
  const history = [{ prompt: "上次", answer: "可见", reasoning: "omit-this-field" }];
  s = await service(t, { messagesUrl: p.messagesUrl, claim: task("chat", { input: { mode: "chat", context: [], prompt: "追问", history } }) });
  await execute(s);
  assert.equal(p.calls.length, 4);
  assert.deepEqual(p.calls.map(c => toolsOf(c.body)), [
    ["read_document","search_workspace"], ["read_document","search_workspace"], ["read_document","search_workspace"], undefined,
  ]);
  for (const c of p.calls) {
    assert.equal(c.headers["x-api-key"], modelKey);
    assert.equal(c.servername, "messages.fixture.invalid");
    assert.equal(c.url, "/anthropic/v1/messages");
    assert.equal(c.body.model, "model_FROM_catalog");
    assert.equal(c.body.stream, true);
    assert.equal(c.body.thinking, undefined);
    assert.equal(c.body.output_config, undefined);
    assert.ok(!JSON.stringify(c).includes(identity.token));
  }
  const first = p.calls[0].body.messages;
  assert.deepEqual(first.map(m => m.role), ["user"]);
  assert.deepEqual(JSON.parse(first[0].content[0].text).history, [{ prompt: "上次", answer: "可见" }]);
  for (const [i, c] of p.calls.entries()) {
    assert.ok(!JSON.stringify(c).includes("omit-this-field"));
    const assistants = c.body.messages.filter(m => m.role === "assistant");
    assert.equal(assistants.length, i);
    for (const m of assistants) assert.deepEqual(m.content[0], { type: "thinking", thinking: thoughts.thought, signature: thoughts.signature });
  }
  const output = s.calls.map(c => c.body);
  for (const privateText of [...Object.values(thoughts), "private-tool-phase", modelKey])
    assert.ok(!JSON.stringify(output).includes(privateText));
  assert.equal(matching(s,"provider").length, 1);
  assert.deepEqual(events(s).filter(e => e.kind === "text_delta").map(e => e.text), ["中文回答"]);
  assert.deepEqual(events(s).map(e => e.executorSeq), events(s).map((_,i) => i + 1));
  assert.deepEqual(matching(s,"result")[0]?.body, { answer: "中文回答", sourceIds: ["source-1"], edits: [] });
});

for (const thinking of [{ mode: "off" }, { mode: "effort", level: "discovered-extreme" }]) {
  test(`probe with ${thinking.mode} uses one minimal synthetic request and a separate receipt`, async (t) => {
    const p = await provider(t, (_,res) => message(res, { text:"ok" }));
    const s = await service(t, { messagesUrl:p.messagesUrl, claim:task("probe", {
      selection: { modelId: "second_dynamic_model", thinking }, input: { prompt: "private chat content" }
    }) });
    await execute(s);
    assert.equal(p.calls.length, 1);
    const { body } = p.calls[0];
    assert.equal(body.model,"second_dynamic_model");
    assert.deepEqual(body.thinking,{type: thinking.mode === "off" ? "disabled" : "enabled"});
    assert.deepEqual(body.output_config,thinking.level ? {effort:thinking.level} : undefined);
    assert.equal(body.tools,undefined);
    assert.ok(!JSON.stringify(body).includes("private chat content"));
    assert.ok(body.max_tokens <= 128);
    assert.deepEqual(matching(s,"result")[0]?.body,{ok:true});
    assert.equal(events(s).length,0);
    assert.equal(matching(s,"sources").length,0);
  });
}

for (const [response, code] of [[401,"authentication"],[429,"rate_limit"],[400,"incompatible"],[503,"unavailable"],[302,"incompatible"],["hang","timeout"]]) {
  test(`probe classifies ${response} without leaking response, retrying generation or following redirect`, async (t) => {
    const p = await provider(t, (_,res) => {
      if (response !== "hang") res.writeHead(response,{location:p.messagesUrl + "/forbidden"}).end("private-error-body");
    });
    const s = await service(t,{messagesUrl:p.messagesUrl,claim:task("probe")});
    await execute(s, { modelTimeout: response === "hang" ? 1250 : 5000 });
    assert.equal(p.calls.length,1);
    assert.equal(matching(s,"fail")[0]?.body.code,code);
    assert.ok(!JSON.stringify(s.calls).includes("private-error-body"));
    assert.equal(matching(s,"result").length,0);
  });
}

test("pinned IP cannot override the certificate hostname", async (t) => {
  const p = await provider(t, (_,res) => message(res,{text:"ok"}));
  const s = await service(t,{messagesUrl:p.messagesUrl.replace("messages.fixture","wrong.fixture"),claim:task("probe")});
  await execute(s);
  assert.equal(p.calls.length,0);
  assert.equal(matching(s,"fail")[0]?.body.code,"unavailable");
});

test("renews and heartbeats during a stalled provider call, stops generation on lost lease", async (t) => {
  let closed = false;
  const p = await provider(t, (_,res) => res.on("close",() => { closed = true; }));
  const claim = task("probe",{expiresAt:Math.floor(Date.now()/1000)+4});
  const s = await service(t,{messagesUrl:p.messagesUrl,claim,override: (c,res,json) => {
    if (!c.route.endsWith("/renew")) return false;
    json({code:"lease_inactive"},409);
    return true;
  }});
  await execute(s, { heartbeatInterval:150 });
  assert.equal(p.calls.length,1);
  await until(() => closed);
  assert.ok(s.calls.filter(c => c.route === "heartbeat").length >= 2);
  assert.equal(matching(s,"provider").length,1);
  assert.equal(matching(s,"result").length+matching(s,"fail").length,0);
});

test("edit stages only previously read sources, retries exact terminal receipt and omits streaming", async t => {
  let puts = 0;
  const p = await provider(t, (_,res,n) => message(res,n === 1
    ? {tool:"submit_document_edits",args:{sourceId:"source-1",markdown:"修改"}}
    : {text:"改完"}));
  const s = await service(t,{messagesUrl:p.messagesUrl,claim:task("chat",{input:{mode:"edit",prompt:"改",context:[{documentId:"doc"}]}}),
    override: (c,res) => {
      if (c.route.endsWith("/result") && ++puts === 1) { res.destroy(); return true; }
    }});
  await execute(s);
  assert.deepEqual(toolsOf(p.calls[0].body),["read_document","search_workspace","submit_document_edits"]);
  const results = matching(s,"result");
  assert.equal(results.length,2);
  assert.deepEqual(results[0].body,results[1].body);
  assert.deepEqual(results[0].body.edits,[{path:"demo.md",baseRevision:"r1",markdown:"修改"}]);
  assert.equal(events(s).some(e => e.kind === "text_delta"),false);
  assert.equal(matching(s,"provider").length,1);
});
