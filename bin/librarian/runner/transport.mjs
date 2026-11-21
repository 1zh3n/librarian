import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { TaskError } from "./wire.mjs";

// The locked adapter calls global fetch. This function is installed only in a
// lease's dedicated worker. Its sole destination is the Rust-approved endpoint.
export function messagesTransport({ messagesUrl, pinnedIp, apiKey }, selection, ca) {
  const endpoint = new URL(messagesUrl);
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.href.includes("?") || endpoint.href.includes("#") || !endpoint.pathname.endsWith("/v1/messages") ||
      !isIP(pinnedIp) || pinnedIp.includes("%") || (isIP(hostname) && hostname !== pinnedIp) ||
      typeof apiKey !== "string" || !apiKey || !selection?.modelId) throw new TaskError("INVALID_ENDPOINT");
  const thinking = selection.thinking;
  if (!["provider_default","off","effort"].includes(thinking?.mode) ||
      (thinking.mode === "effort" && !(typeof thinking.level === "string" && thinking.level.length))) throw new TaskError("INVALID_SELECTION");

  return async (url, init) => {
    if (String(url) !== endpoint.href || init.method !== "POST" || init.redirect !== "error") throw new TaskError("INVALID_ENDPOINT");
    const body = JSON.parse(init.body);
    if (body.model !== selection.modelId || body.stream !== true) throw new TaskError("INVALID_SELECTION");
    // rc.5 supplies its own high/default and accepts only a fixed set of levels.
    // Apply the exact discovered selection after official Messages serialization.
    delete body.thinking;
    delete body.output_config;
    if (thinking.mode === "off") body.thinking = { type: "disabled" };
    if (thinking.mode === "effort") {
      body.thinking = { type: "enabled" };
      body.output_config = { effort: thinking.level };
    }
    if (body.tools?.length === 0) delete body.tools;
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new TaskError("INPUT_LIMIT");
    return new Promise((resolve, reject) => {
      const req = https.request(endpoint, {
        method: "POST", headers: { ...init.headers, "x-api-key": apiKey },
        agent: false, autoSelectFamily: false, family: isIP(pinnedIp), signal: init.signal,
        lookup: (_host, options, cb) => options.all
          ? cb(null, [{address:pinnedIp, family:isIP(pinnedIp)}])
          : cb(null, pinnedIp, isIP(pinnedIp)),
        rejectUnauthorized: true, ca,
      }, (res) => {
        const status = res.statusCode;
        if (status !== 200) {
          res.destroy();
          // Neither follow Location nor pass unbounded provider-controlled diagnostics to Harness.
          resolve(new Response(null, {status}));
          return;
        }
        let bytes = 0;
        const limited = Readable.from((async function* () {
          for await (const chunk of res) {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) throw new TaskError("RESPONSE_LIMIT");
            yield chunk;
          }
        })());
        resolve(new Response(Readable.toWeb(limited), {status}));
      });
      req.on("error", reject);
      req.end(payload);
    });
  };
}
