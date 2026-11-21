import { setTimeout as sleep } from "node:timers/promises";

export class TaskError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function apiClient(librarianUrl, identity) {
  const base = new URL(librarianUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(local && base.protocol === "http:")) ||
      base.username || base.password || base.href.includes("?") || base.href.includes("#") ||
      !identity?.instanceId || !identity.token) throw new TaskError("INVALID_INSTANCE");
  base.pathname = base.pathname.replace(/\/*$/, "/") + "api/v1/ai/runner/v2/";
  const headers = {
    "authorization": "Bearer " + identity.token,
    "x-librarian-runner-id": identity.instanceId,
    "content-type": "application/json",
  };
  return async (path, method, body, signal, attempts = 3) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(new URL(path, base), {
          method, headers, body: payload, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
          redirect: "error", cache: "no-store",
        });
        if (response.status === 204) return null;
        if (!response.ok) {
          const { code } = await response.json().catch(() => ({}));
          throw new TaskError(["not_found", "lease_inactive", "revision_conflict"].includes(code) ? code : "API_ERROR", response.status);
        }
        if (path.endsWith("/provider") && !response.headers.get("cache-control")?.split(",").some(v => v.trim().toLowerCase() === "no-store")) {
          throw new TaskError("UNSAFE_CREDENTIAL_RESPONSE");
        }
        return await response.json();
      } catch (error) {
        signal.throwIfAborted();
        const failure = error instanceof TaskError ? error : new TaskError("API_TRANSPORT");
        if (attempt >= attempts || !(failure.code === "API_TRANSPORT" || failure.status >= 500 ||
            [408,425,429].includes(failure.status))) throw failure;
        await sleep(200 * 2 ** (attempt - 1), undefined, {signal});
      }
    }
  };
}
