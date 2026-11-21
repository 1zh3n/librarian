#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { MAX_SOURCE_BYTES, prepareChat } from "./tools.mjs";
import { apiClient, TaskError } from "./wire.mjs";

const DIAGNOSTICS = {
  authentication: "模型鉴权失败，请检查已保存的密钥。",
  rate_limit: "模型请求受到限流，请稍后重试。",
  timeout: "模型请求超时，请稍后重试。",
  incompatible: "模型未返回兼容的 Messages 结果，请检查配置。",
  unavailable: "模型连接暂不可用，请检查地址及服务状态。",
};
const TASK_DIAGNOSTICS = {
  revision_conflict: "引用的文档已更新，请刷新后重试。",
  DOCUMENT_UNAVAILABLE: "引用的文档已不可用，请重新选择后重试。",
  workspace_manage_required: "当前账户缺少管理此工作区的权限。",
};

function closedLease(error) {
  return error.code === "lease_inactive" || [401, 403, 404, 410].includes(error.status);
}

function classify(error) {
  switch (error.code) {
    case "AUTH":
      return "authentication";
    case "RATE_LIMIT":
      return "rate_limit";
    case "TIMEOUT":
      return "timeout";
    case "TRANSPORT":
    case "SERVER":
    case "API_TRANSPORT":
    case "API_ERROR":
      return "unavailable";
    default:
      return "incompatible";
  }
}

// Each task gets a fresh VM for the SDK's global fetch and in-memory reasoning replay.
// The instance token and service URL stay in the parent process.
async function generate(data, tools, onText, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./harness-worker.mjs", import.meta.url), {
    workerData: {
      ...data,
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    },
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      worker.on("error", () => reject(new TaskError("WORKER_FAILURE")));
      worker.on("exit", () => reject(new TaskError("WORKER_EXIT")));
      worker.on("message", async (message) => {
        try {
          signal.throwIfAborted();
          switch (message.kind) {
            case "done":
              return resolve(message.answer);
            case "failure":
              return reject(new TaskError(message.code));
            case "text":
              await onText(message.text);
              worker.postMessage({ id: message.id });
              break;
            case "tool": {
              const tool = tools.find((t) => t.name === message.name);
              if (!tool) throw new TaskError("UNREGISTERED_TOOL");
              const value = await tool.execute(message.args);
              worker.postMessage({ id: message.id, value });
              break;
            }
            default:
              throw new TaskError("WORKER_PROTOCOL");
          }
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

function reporter(client, onError) {
  let seq = 0;
  let bytes = 0;
  let pending = "";
  let last = 0;
  let timer;
  let delivery = Promise.resolve();
  const emit = (kind, text) => client("events", "POST", { executorSeq: ++seq, kind, text });
  function stopTimer() {
    clearTimeout(timer);
    timer = undefined;
  }
  async function send(text) {
    while (text) {
      // The service accepts 8192 UTF-8 bytes per event. Keep scalar boundaries.
      let size = 0;
      let end = 0;
      for (const ch of text) {
        size += Buffer.byteLength(ch);
        if (size > 8192) break;
        end += ch.length;
      }
      await emit("text_delta", text.slice(0, end));
      text = text.slice(end);
    }
  }
  function flush() {
    stopTimer();
    if (pending) {
      const text = pending;
      pending = "";
      last = performance.now();
      // A timed flush, an arriving chunk and EOF must all see the same ordered delivery.
      delivery = delivery.then(() => send(text));
    }
    return delivery;
  }
  return {
    progress: (text) => emit("progress", text),
    async text(delta) {
      await delivery;
      bytes += Buffer.byteLength(delta);
      if (bytes > MAX_SOURCE_BYTES) throw new TaskError("ANSWER_LIMIT");
      pending += delta;
      // Leave enough of the service's 512 event slots for a full-size remainder.
      if (!last || Buffer.byteLength(pending) >= 4096) {
        await flush();
      } else if (seq < 400 && timer === undefined) {
        timer = setTimeout(
          () => flush().catch(onError),
          Math.max(0, 75 - (performance.now() - last)),
        );
      }
    },
    flush,
    stopTimer,
  };
}

async function periodic(signal, delay, action) {
  while (!signal.aborted) {
    await sleep(delay(), undefined, { signal });
    await action();
  }
}

async function runLease(claim, api, settings, shutdown) {
  const life = new AbortController();
  const signal = AbortSignal.any([life.signal, shutdown]);
  const prefix = "claims/" + encodeURIComponent(claim.leaseId) + "/";
  if (!claim.leaseId || [".", ".."].includes(claim.leaseId)) throw new TaskError("INVALID_LEASE");
  const client = (route, method, body, attempts) =>
    api(prefix + route, method, body, signal, attempts);
  let expiry = claim.expiresAt;
  const renewal = periodic(
    signal,
    () => Math.max(100, Math.min(40_000, (expiry * 1000 - Date.now()) / 3)),
    async () => {
      ({ expiresAt: expiry } = await client("renew", "POST", {}));
    },
  ).catch((error) => {
    if (!signal.aborted) life.abort(error);
  });

  const work = new AbortController();
  const workSignal = AbortSignal.any([signal, work.signal]);
  const workClient = (route, method, body) => api(prefix + route, method, body, workSignal);
  const output = reporter(workClient, (error) => work.abort(error));
  let submitting = false;
  try {
    if (!["probe", "chat"].includes(claim.taskKind)) throw new TaskError("INVALID_TASK");
    const provider = await client("provider", "GET", undefined, 1);
    const probe = claim.taskKind === "probe";
    const chat = probe ? null : await prepareChat(claim.input, workClient, output.progress);
    if (chat) await output.progress("正在请求模型。");
    const deadline = AbortSignal.timeout(settings.modelTimeout);
    const answer = await generate(
      {
        provider,
        selection: claim.selection,
        ca: settings.ca,
        taskKind: claim.taskKind,
        mode: probe ? undefined : claim.input.mode,
        prompt: chat?.prompt,
      },
      chat?.tools ?? [],
      output.text,
      AbortSignal.any([workSignal, deadline]),
    ).catch((error) => {
      if (deadline.aborted) throw new TaskError("TIMEOUT");
      throw error;
    });
    await output.flush();
    const result = probe ? { ok: true } : chat.result(answer);
    submitting = true;
    await client("result", "PUT", result);
  } catch (error) {
    work.abort(error);
    output.stopTimer();
    if (signal.aborted || error.code === "lease_inactive" || [401, 410].includes(error.status)) return;
    // A lost result receipt may already have committed; allow server-side recovery.
    // A definitive rejection can concern the proposed action on an otherwise active lease.
    if (submitting && ![400, 403, 404, 413, 422].includes(error.status)) throw error;
    const code = classify(error);
    const text = TASK_DIAGNOSTICS[error.code] ?? DIAGNOSTICS[code];
    try {
      await client("fail", "POST", claim.taskKind === "probe" ? { code, text } : { text });
    } catch (failure) {
      if (!signal.aborted && !closedLease(failure)) throw failure;
    }
  } finally {
    output.stopTimer();
    work.abort();
    life.abort();
    await renewal;
  }
}

export async function runOnce({
  librarianUrl,
  identity,
  signal,
  heartbeatInterval = 10_000,
  modelTimeout = 90_000,
  ca,
}) {
  const api = apiClient(librarianUrl, identity);
  const life = new AbortController();
  const active = AbortSignal.any([life.signal, signal]);
  const beat = () => api("heartbeat", "POST", {}, active, 1);
  await beat();
  const heartbeat = periodic(active, () => heartbeatInterval, beat).catch((error) => {
    if (!active.aborted) life.abort(error);
  });
  try {
    const claim = await api("claims", "POST", {}, active, 1);
    if (claim) await runLease(claim, api, { modelTimeout, ca }, active);
    if (life.signal.aborted) throw life.signal.reason;
    return Boolean(claim);
  } finally {
    life.abort();
    await heartbeat;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("node runner.mjs [--once]\nSet LIBRARIAN_URL and LIBRARIAN_RUNNER_IDENTITY_FILE.");
    return;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--once"))
    throw new TaskError("INVALID_ARGUMENT");
  const file = await open(
    process.env.LIBRARIAN_RUNNER_IDENTITY_FILE,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let identity;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192)
      throw new TaskError("INVALID_INSTANCE");
    identity = JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
  const controller = new AbortController();
  const { signal } = controller;
  for (const name of ["SIGTERM", "SIGINT"]) process.once(name, () => controller.abort());
  let delay = 1000;
  while (!signal.aborted) {
    try {
      const claimed = await runOnce({ librarianUrl: process.env.LIBRARIAN_URL, identity, signal });
      if (args.length) return;
      delay = 1000;
      if (claimed) continue;
    } catch (error) {
      if (signal.aborted) return;
      if (args.length || [401, 403].includes(error.status)) throw error;
      console.error("Managed runner could not complete its poll.");
      delay = Math.min(15_000, delay * 2);
    }
    await sleep(delay, undefined, { signal }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Managed runner failed. Check the instance identity and service connection.");
    process.exitCode = 1;
  });
}
