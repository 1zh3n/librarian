import { api, ApiError } from "../../api/client";
import type { AiOperation } from "../../api/client";

type OperationEvent =
  | { id: number; kind: "operation"; data: AiOperation }
  | { id: number; kind: "progress" | "text_delta"; data: { text: string } };

export function* operationEvents(payload: string): Generator<OperationEvent> {
  for (const frame of payload.split(/\r?\n\r?\n/u)) {
    let id = 0;
    let kind = "";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/u)) {
      const delimiter = line.indexOf(":");
      if (delimiter < 1) continue;
      const name = line.slice(0, delimiter);
      const value = line.slice(delimiter + 1).replace(/^ /u, "");
      if (name === "id") id = Number(value);
      else if (name === "event") kind = value;
      else if (name === "data") data.push(value);
    }
    if (!Number.isSafeInteger(id) || id < 1 || data.length === 0) continue;
    if (kind === "operation") yield { id, kind, data: JSON.parse(data.join("\n")) as AiOperation };
    else if (kind === "progress" || kind === "text_delta")
      yield { id, kind, data: JSON.parse(data.join("\n")) as { text: string } };
  }
}

export function isActiveOperation(operation: AiOperation) {
  return operation.status === "queued" || operation.status === "running";
}

export function followOperation(
  id: string,
  receive: (event: OperationEvent) => void,
  reportConnection: (state: "connected" | "retrying" | "unavailable") => void,
) {
  const controller = new AbortController();
  let cursor = 0;
  let timer: number | undefined;

  async function replay() {
    let repeat = true;
    try {
      const payload = await api.readAiEvents(id, cursor, controller.signal);
      if (controller.signal.aborted) return;
      reportConnection("connected");
      for (const event of operationEvents(payload)) {
        if (event.id <= cursor) continue;
        cursor = event.id;
        receive(event);
        if (event.kind === "operation" && !isActiveOperation(event.data)) repeat = false;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      repeat = !(error instanceof ApiError && error.status >= 400 && error.status < 500);
      reportConnection(repeat ? "retrying" : "unavailable");
    }
    if (repeat) timer = window.setTimeout(() => void replay(), 600);
  }

  void replay();
  return () => {
    controller.abort();
    window.clearTimeout(timer);
  };
}
