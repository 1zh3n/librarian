import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempDisposableSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";

export const identity = { instanceId: "fixture-instance", token: "instance-fixture-only" };
export const modelKey = "provider-fixture-only";
const name = "messages.fixture.invalid";
// Generated for this test run. No developer or deployment credentials involved.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const key = privateKey.export({ type: "pkcs8", format: "pem" });
function certificate() {
  using temp = mkdtempDisposableSync(join(tmpdir(), "runner-cert-"));
  const path = join(temp.path, "key");
  writeFileSync(path, key, { mode: 0o600 });
  return execFileSync("openssl", [
  "req", "-x509", "-new", "-key", path, "-days", "1",
  "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:" + name,
], { encoding: "utf8", });
}
export const ca = certificate();

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  }));
  return server.address().port;
}

async function bodyOf(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts)) : null;
}

export function message(response, { text = "", thought, signature, tool, args, beforeEnd }) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type, fields = {}) => response.write(
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
  );
  event("message_start", { message: { usage: { input_tokens: 5 } } });
  let index = 0;
  if (thought) {
    event("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
    event("content_block_delta", { index, delta: { type: "thinking_delta", thinking: thought } });
    event("content_block_delta", { index, delta: { type: "signature_delta", signature } });
    event("content_block_stop", { index: index++ });
  }
  event("content_block_start", { index, content_block: tool
    ? { type: "tool_use", id: "call_fixture", name: tool, input: {} }
    : { type: "text", text: "" } });
  if (tool) {
    event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } });
  } else {
    // Split inside a multibyte character, including across the awaited final text receipt.
    const data = Buffer.from(`data: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } })}\n\n`);
    const cut = Math.max(1, data.indexOf(Buffer.from(text)) + 1);
    response.write(data.subarray(0, cut));
    response.write(data.subarray(cut));
  }
  return (async () => {
    await beforeEnd?.();
    event("content_block_stop", { index });
    event("message_delta", { delta: {}, usage: { output_tokens: 2 } });
    event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" } });
    event("message_stop");
    response.end();
  })();
}

export async function provider(t, script) {
  const calls = [];
  const server = createTlsServer({ cert: ca, key }, async (req, res) => {
    const call = { body: await bodyOf(req), host: req.headers.host, servername: req.socket.servername,
      headers: req.headers, url: req.url };
    calls.push(call);
    try { await script(call, res, calls.length); }
    catch { res.destroy(); }
  });
  const port = await listen(t, server);
  return { calls, messagesUrl: `https://${name}:${port}/anthropic/v1/messages` };
}

export function task(taskKind = "chat", extra = {}) {
  return {
    taskKind, operationId: "fixture-op", leaseId: "fixture-lease",
    expiresAt: Math.floor(Date.now() / 1000) + 120,
    selection: { modelId: "model_FROM_catalog", thinking: { mode: "provider_default" } },
    input: { mode: "chat", prompt: "继续", context: [] }, ...extra,
  };
}

export async function service(t, { claim, messagesUrl, override }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const route = req.url.replace(/^\/api\/v1\/ai\/runner\/v2\//, "");
    const call = { route, method: req.method, body: await bodyOf(req), headers: req.headers };
    calls.push(call);
    const json = (value, status = 200, headers = {}) => res.writeHead(status, {
      "content-type": "application/json", ...headers,
    }).end(JSON.stringify(value));
    if (req.headers.authorization !== "Bearer " + identity.token ||
        req.headers["x-librarian-runner-id"] !== identity.instanceId) return json({}, 401);
    if (await override?.(call, res, json)) return;
    if (route === "heartbeat") return res.writeHead(204).end();
    if (route === "claims") return claim ? json(claim) : res.writeHead(204).end();
    const prefix = "claims/fixture-lease/";
    if (!route.startsWith(prefix)) return json({}, 404);
    switch (route.slice(prefix.length).split("?")[0]) {
      case "provider": return json({ messagesUrl, pinnedIp: "127.0.0.1", apiKey: modelKey }, 200, { "cache-control": "no-store" });
      case "events": case "result": case "fail": return json({});
      case "renew": return json({ expiresAt: Math.floor(Date.now() / 1000) + 120 });
      case "documents": return json([{ id: "doc", title: "合成", path: "demo.md" }]);
      case "sources": return json({ markdown: "参考", source: { id: "source-1", path: "demo.md", revision: "r1" } });
      default: return json({}, 404);
    }
  });
  const port = await listen(t, server);
  return { calls, librarianUrl: `http://127.0.0.1:${port}` };
}

export async function until(predicate, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("expected fixture event before deadline");
    await sleep(10);
  }
}
