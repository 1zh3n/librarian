import assert from "node:assert/strict";
import test from "node:test";
import { ca, identity, message, modelKey, provider, service, task } from "./fixtures.mjs";
import { runOnce } from "./runner.mjs";

function textStream(res, pieces) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (type, fields = {}) =>
    res.write(`data: ${JSON.stringify({ type, ...fields })}\n\n`);
  frame("message_start", { message: { usage: { input_tokens: 1 } } });
  frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const text of pieces)
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  frame("content_block_stop", { index: 0 });
  frame("message_delta", { delta: { stop_reason: "end_turn" } });
  frame("message_stop");
  res.end();
}

async function run(t, reply, input = { mode: "chat", prompt: "合成", context: [] }) {
  const p = await provider(t, reply);
  const s = await service(t, { claim: task("chat", { input }), messagesUrl: p.messagesUrl });
  await runOnce({ librarianUrl: s.librarianUrl, identity, ca, signal: AbortSignal.timeout(8000) });
  return s.calls;
}

test("an echoed credential split across final text deltas reaches neither stream nor receipt", async (t) => {
  const calls = await run(t, (_, res, n) =>
    n === 1
      ? message(res, { text: "ready" })
      : textStream(res, ["中文。", modelKey.slice(0, 7), modelKey.slice(7)]),
  );
  const visible = calls
    .filter((c) => c.body?.kind === "text_delta")
    .map((c) => c.body.text)
    .join("");
  assert.equal(visible, "中文。");
  assert.equal(
    calls.some((c) => c.route.endsWith("/result")),
    false,
  );
  assert.equal(calls.filter((c) => c.route.endsWith("/fail")).length, 1);
  assert.ok(!JSON.stringify(calls).includes(modelKey));
});

test("safe prefixes matching part of the credential survive exactly, including at EOF", async (t) => {
  const pieces = ["中文。", modelKey.slice(0, 9), "普通文本。", modelKey.slice(0, 4)];
  const calls = await run(t, (_, res, n) =>
    n === 1 ? message(res, { text: "ready" }) : textStream(res, pieces),
  );
  const visible = calls
    .filter((c) => c.body?.kind === "text_delta")
    .map((c) => c.body.text)
    .join("");
  assert.equal(visible, pieces.join(""));
  assert.equal(calls.find((c) => c.route.endsWith("/result"))?.body.answer, visible);
});

test("provider credential in a tool argument cannot enter service requests", async (t) => {
  const calls = await run(t, (_, res, n) =>
    n === 1
      ? message(res, { tool: "search_workspace", args: { query: modelKey } })
      : message(res, { text: "done" }),
  );
  assert.ok(!JSON.stringify(calls).includes(modelKey));
  assert.equal(
    calls.some((c) => c.route.includes("/documents?")),
    false,
  );
  assert.equal(
    calls.some((c) => c.route.endsWith("/result")),
    false,
  );
  assert.ok(calls.some((c) => c.route.endsWith("/fail")));
});

test("edit summary cannot persist an echoed credential", async (t) => {
  const calls = await run(t, (_, res) => message(res, { text: "done " + modelKey }), {
    mode: "edit",
    prompt: "合成",
    context: [],
  });
  assert.ok(!JSON.stringify(calls).includes(modelKey));
  assert.equal(
    calls.some((c) => c.route.endsWith("/result")),
    false,
  );
  assert.ok(calls.some((c) => c.route.endsWith("/fail")));
});
