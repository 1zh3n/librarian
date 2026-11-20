import type { components, operations } from "./schema.gen";

export type Workspace = components["schemas"]["Workspace"];
export type DocumentSummary = components["schemas"]["DocumentSummary"];
export type DocumentSnapshot = components["schemas"]["DocumentSnapshot"];

type ListOptions = NonNullable<operations["listDocuments"]["parameters"]["query"]>;
type CreateDocument = operations["createDocument"]["requestBody"]["content"]["application/json"];
type SaveDocument = operations["saveDocument"]["requestBody"]["content"]["application/json"];
type ErrorBody = components["schemas"]["ApiError"];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentRevision: string | undefined;

  constructor(status: number, code: string, message: string, currentRevision?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

async function request<T>(
  path: string,
  signal?: AbortSignal,
  write?: { method: "POST" | "PUT"; body: CreateDocument | SaveDocument },
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    signal: signal ?? null,
    credentials: "same-origin",
    ...(write && {
      method: write.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write.body),
    }),
  });
  if (response.ok) return (await response.json()) as T;

  const error = (await response.json().catch(() => null)) as Partial<ErrorBody> | null;
  throw new ApiError(
    response.status,
    error?.code ?? "request_failed",
    error?.message ?? `Request failed (${response.status})`,
    error?.currentRevision,
  );
}

const workspaceDocuments = (workspace: string) =>
  `/workspaces/${encodeURIComponent(workspace)}/documents`;

export const api = {
  listWorkspaces(signal?: AbortSignal) {
    return request<Workspace[]>("/workspaces", signal);
  },
  listDocuments(workspace: string, options: ListOptions = {}, signal?: AbortSignal) {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set("after", options.after);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return request<DocumentSummary[]>(`${workspaceDocuments(workspace)}${suffix}`, signal);
  },
  createDocument(workspace: string, body: CreateDocument, signal?: AbortSignal) {
    return request<DocumentSnapshot>(workspaceDocuments(workspace), signal, {
      method: "POST",
      body,
    });
  },
  getDocument(document: string, signal?: AbortSignal) {
    return request<DocumentSnapshot>(`/documents/${encodeURIComponent(document)}`, signal);
  },
  saveDocument(document: string, body: SaveDocument, signal?: AbortSignal) {
    return request<DocumentSnapshot>(`/documents/${encodeURIComponent(document)}`, signal, {
      method: "PUT",
      body,
    });
  },
};
