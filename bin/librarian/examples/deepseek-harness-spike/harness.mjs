import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { createUserMessage } from "@deepseek-ai/dsh-llm";
import { DeepSeekAdapter, resolveAdapterOptions } from "@deepseek-ai/dsh-llm-deepseek";
import SessionStore from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as NativeToolExecutor from "@deepseek-ai/dsh-tool-executor-native";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

const MAX_ROUNDS = 8;

export class HarnessFailure extends Error {
  constructor(code) {
    super(`Harness execution ended with ${code}.`);
    this.code = code;
  }
}

export async function runHarness({ baseUrl, model, apiKey, signal, systemPrompt, prompt, tools }) {
  signal.throwIfAborted();
  const started = performance.now();
  const ctx = new Context();
  const plugins = [];
  let handle;
  let abort;
  try {
    for (const [plugin, options] of [
      [LlmRuntime],
      [SessionStore],
      [SessionProjection],
      [
        SystemPrompt,
        {
          personaPrefix: systemPrompt,
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
        },
      ],
      [ToolRuntime],
      [NativeToolExecutor],
      [AgentRegistry],
      [AgentLoop, { agents: [], maxParallelToolCalls: 1 }],
    ]) {
      const fiber = ctx.plugin(plugin, options);
      await fiber;
      plugins.push(fiber);
    }
    const connection = resolveAdapterOptions({ baseURL: baseUrl, thinking: "disabled" });
    const userId = randomUUID();
    const adapter = new DeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: { "x-api-key": apiKey } }),
      resolveUserId: () => userId,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    });
    ctx.llm.registerAdapter(["deepseek-official"], adapter);
    let rounds = 0;
    handle = await ctx.agents.create({
      sessionId: randomUUID(),
      agentOptions: { provider: "deepseek-official", model, maxTokens: 8192 },
      setup(agentCtx) {
        for (const tool of tools) {
          agentCtx.tools.register(
            defineTool({
              ...tool,
              output: {
                schema: { type: "json" },
                render: (_args, result) => [{ type: "text", text: JSON.stringify(result) }],
              },
            }),
          );
        }
        agentCtx.on("agent/pre-step", (payload, next) => {
          if (rounds === MAX_ROUNDS) return { kind: "reject" };
          rounds += 1;
          return next(payload);
        });
      },
    });
    const { agent } = handle;
    abort = () => agent.cancel({ kind: "user" });
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    agent.followup(
      createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }),
    );
    await agent.whenIdle();
    signal.throwIfAborted();
    const events = agent.session.snapshotEvents();
    const end = events.findLast(({ type }) => type === "turn/end")?.data.reason;
    const messages = events.filter(({ type }) => type === "assistant/message");
    const answer = messages
      .at(-1)
      ?.data.message.content.filter(({ type }) => type === "text")
      .map(({ text }) => text)
      .join("");
    if (end?.kind !== "completed" || !answer?.trim()) {
      const code = end?.kind === "error" ? end.error.code : end?.kind;
      throw new HarnessFailure(
        rounds === MAX_ROUNDS && end?.kind === "blocked" ? "ROUND_LIMIT" : (code ?? "EMPTY_ANSWER"),
      );
    }
    const callNames = new Map(
      events.filter(({ type }) => type === "tool/call").map(({ data }) => [data.callId, data.name]),
    );
    const toolErrors = events
      .filter(({ type, data }) => type === "tool/result" && data.error)
      .map(({ data }) => ({
        name: data.message.name ?? callNames.get(data.message.toolCallId),
        code: data.error.code,
      }));
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (const message of messages) {
      usage.inputTokens += message.data.usage?.inputTokens ?? 0;
      usage.outputTokens += message.data.usage?.outputTokens ?? 0;
    }
    return {
      answer,
      rounds,
      usage,
      toolCalls: [...callNames.values()],
      toolErrors,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    await handle?.dispose();
    for (const plugin of plugins.reverse()) await plugin.dispose();
  }
}
