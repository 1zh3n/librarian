import assert from "node:assert/strict";
import { provider } from "./model-fixture.mjs";
import test from "node:test";

const TOOL_NAMES = ["read_document", "search_workspace", "submit_document_edits"];

const definitions = {
  search_workspace: { parameters: { query: { type: "string", required: true } } },
  read_document: { parameters: { documentId: { type: "string", required: true } } },
  submit_document_edits: { parameters: { sourceId: { type: "string", required: true } } },
};

async function run(provider, omit) {
  const { runHarness } = await import("./harness.mjs");
  const called = [];
  const tools = Object.entries(definitions)
    .filter(([name]) => name !== omit)
    .map(([name, definition]) => ({
      ...definition,
      name,
      description: `Fixture ${name}`,
      execute: (args) => {
        called.push([name, args]);
        return { text: "合成工具结果" };
      },
    }));
  const result = await runHarness({
    baseUrl: provider.baseUrl,
    model: "deepseek-flash",
    apiKey: "local-only-model-key",
    signal: AbortSignal.timeout(5_000),
    systemPrompt: "只处理合成样本。",
    prompt: "这是合成问题。",
    tools,
  });
  return { result, called };
}

test("official DeepSeek adapter sends the exact document tools and replays native tool results", async (t) => {
  const model = await provider(t, [
    { tool: "search_workspace", args: { query: "鸟鸣" } },
    { text: "合成答案" },
  ]);
  const { result, called } = await run(model);
  assert.equal(result.answer, "合成答案");
  assert.deepEqual(called, [["search_workspace", { query: "鸟鸣" }]]);
  assert.equal(model.requests.length, 2);
  assert.equal(result.rounds, 2);
  assert.equal(result.usage.inputTokens, 40);
  assert.equal(result.usage.outputTokens, 10);
  for (const request of model.requests) {
    assert.equal(request.url, "/v1/messages");
    assert.equal(request.apiKey, "local-only-model-key");
    assert.equal(request.body.stream, true);
    assert.equal(request.body.model, "deepseek-flash");
    assert.deepEqual(request.body.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
    assert.ok(JSON.stringify(request.body.system).includes("只处理合成样本。"));
  }
  assert.ok(
    model.requests[1].body.messages.some(({ content }) =>
      content.some(
        (block) =>
          block.type === "tool_result" && JSON.stringify(block.content).includes("合成工具结果"),
      ),
    ),
  );
});

for (const omitted of TOOL_NAMES) {
  test(`calling disabled ${omitted} produces UNKNOWN_TOOL without dispatch`, async (t) => {
    const model = await provider(t, [{ tool: omitted, args: {} }, { text: "合成答案" }]);
    const { result, called } = await run(model, omitted);
    assert.deepEqual(called, []);
    assert.deepEqual(result.toolErrors, [{ name: omitted, code: "UNKNOWN_TOOL" }]);
    assert.ok(
      model.requests.every(({ body }) => !body.tools.some((tool) => tool.name === omitted)),
    );
    assert.ok(
      model.requests[1].body.messages.some(({ content }) =>
        content.some((block) => block.type === "tool_result" && block.is_error),
      ),
    );
  });
}

test("a continuing tool loop makes at most eight provider requests", async (t) => {
  const model = await provider(
    t,
    Array.from({ length: 12 }, () => ({
      tool: "search_workspace",
      args: { query: "继续" },
    })),
  );
  await assert.rejects(run(model), { code: "ROUND_LIMIT" });
  assert.equal(model.requests.length, 8);
});

test("provider authorization rejection is classified without returning its body", async (t) => {
  const model = await provider(t, [{ status: 401, text: "PRIVATE_PROVIDER_BODY" }]);
  await assert.rejects(run(model), (error) => {
    assert.equal(error.code, "AUTH");
    assert.ok(!error.message.includes("PRIVATE_PROVIDER_BODY"));
    return true;
  });
  assert.equal(model.requests.length, 1);
});
