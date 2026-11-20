import type { components, operations } from "./schema.gen";

export type Workspace = components["schemas"]["Workspace"];
export type DocumentSummary = components["schemas"]["DocumentSummary"];
export type DocumentSnapshot = components["schemas"]["DocumentSnapshot"];
export type SearchHit = components["schemas"]["SearchHit"];
export type OutlineSnapshot = components["schemas"]["OutlineSnapshot"];
export type DocumentHistory = components["schemas"]["DocumentHistory"];
export type VersionDiff = components["schemas"]["VersionDiff"];
export type RestoredDocument = components["schemas"]["RestoredDocument"];
export type DevicePreferences = components["schemas"]["DevicePreferences"];

type ListOptions = NonNullable<operations["listDocuments"]["parameters"]["query"]>;
type CreateDocument = operations["createDocument"]["requestBody"]["content"]["application/json"];
type SaveDocument = operations["saveDocument"]["requestBody"]["content"]["application/json"];
type SaveOutline = operations["saveOutline"]["requestBody"]["content"]["application/json"];
type RestoreRevision = operations["restoreDocument"]["requestBody"]["content"]["application/json"];
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
  write?: {
    method: "POST" | "PUT";
    body: CreateDocument | SaveDocument | SaveOutline | RestoreRevision | DevicePreferences;
  },
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
const documentPath = (document: string) => `/documents/${encodeURIComponent(document)}`;

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
  searchDocuments(workspace: string, q: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ q });
    return request<SearchHit[]>(
      `/workspaces/${encodeURIComponent(workspace)}/search?${query.toString()}`,
      signal,
    );
  },
  createDocument(workspace: string, body: CreateDocument, signal?: AbortSignal) {
    return request<DocumentSnapshot>(workspaceDocuments(workspace), signal, {
      method: "POST",
      body,
    });
  },
  getDocument(document: string, signal?: AbortSignal) {
    return request<DocumentSnapshot>(documentPath(document), signal);
  },
  saveDocument(document: string, body: SaveDocument, signal?: AbortSignal) {
    return request<DocumentSnapshot>(documentPath(document), signal, {
      method: "PUT",
      body,
    });
  },
  getOutline(document: string, signal?: AbortSignal) {
    return request<OutlineSnapshot>(`${documentPath(document)}/outline`, signal);
  },
  saveOutline(document: string, body: SaveOutline, signal?: AbortSignal) {
    return request<OutlineSnapshot>(`${documentPath(document)}/outline`, signal, {
      method: "PUT",
      body,
    });
  },
  getDocumentHistory(document: string, before?: string, signal?: AbortSignal) {
    const suffix = before ? `?${new URLSearchParams({ before })}` : "";
    return request<DocumentHistory>(`${documentPath(document)}/revisions${suffix}`, signal);
  },
  getVersionDiff(document: string, commit: string, signal?: AbortSignal) {
    return request<VersionDiff>(
      `${documentPath(document)}/revisions/${encodeURIComponent(commit)}/diff`,
      signal,
    );
  },
  restoreDocument(document: string, body: RestoreRevision, signal?: AbortSignal) {
    return request<RestoredDocument>(`${documentPath(document)}/restore`, signal, {
      method: "POST",
      body,
    });
  },
  getDevicePreferences(device: string, signal?: AbortSignal) {
    return request<DevicePreferences>(`/settings/devices/${encodeURIComponent(device)}`, signal);
  },
  saveDevicePreferences(device: string, body: DevicePreferences) {
    return request<DevicePreferences>(
      `/settings/devices/${encodeURIComponent(device)}`,
      undefined,
      {
        method: "PUT",
        body,
      },
    );
  },
};
