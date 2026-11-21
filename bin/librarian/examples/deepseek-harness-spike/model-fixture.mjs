import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

export async function provider(t, responses) {
  const requests = [];
  let failure;
  const server = createServer((request, response) => {
    serve(request, response).catch((error) => {
      failure ??= error;
      response.writeHead(400).end();
    });
  });
  async function serve(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      apiKey: request.headers["x-api-key"],
      body: JSON.parse(Buffer.concat(chunks)),
    });
    const reply = responses[requests.length - 1] ?? { text: "完成" };
    const { text, tool, args, status, hang } =
      typeof reply === "function" ? await reply(requests.at(-1), requests) : reply;
    if (status) return response.writeHead(status).end(text);
    if (hang) return;
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          model: "deepseek-flash",
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: `call_${requests.length}`, name: tool, input: {} }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify(args) }
          : { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    );
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    assert.ifError(failure);
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
