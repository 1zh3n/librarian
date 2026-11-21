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
export type AiTask = components["schemas"]["AiTask"];
export type AiContext = components["schemas"]["AiContext"];
export type AiOperation = components["schemas"]["AiOperation"];
export type MutationReceipt = components["schemas"]["MutationReceipt"];
type AiOperationDiff = components["schemas"]["AiOperationDiff"];
type AiConfirm = components["schemas"]["AiConfirmRequest"];

type CreateWorkspace = components["schemas"]["CreateWorkspace"];
type UpdateWorkspace = components["schemas"]["UpdateWorkspace"];
type RenameWorkspacePath = components["schemas"]["RenameWorkspacePaths"];
export type WorkspaceSettings = Omit<CreateWorkspace, "origin">;
export type DeliveryManifest = components["schemas"]["DeliveryManifest"];
type DeliveryInput = components["schemas"]["DeliveryRequest"];
export type DeliveryReceipt = components["schemas"]["DeliveryReceipt"];
type NewDeliveryToken = components["schemas"]["NewDeliveryToken"];
export type DeliveryToken = components["schemas"]["DeliveryToken"];
type IssuedDeliveryToken = components["schemas"]["IssuedDeliveryToken"];
export type CreateSnapshot = components["schemas"]["CreateSnapshot"];
export type SnapshotLink = components["schemas"]["SnapshotLink"];
export type Snapshot = components["schemas"]["ReaderSnapshot"];

export type BackupSettings = components["schemas"]["BackupSettings"];
export type BackupJob = components["schemas"]["BackupJob"];
export type SaveBackupSettings = components["schemas"]["SaveBackupSettings"];
type PublicationTargets =
  operations["listPublicationTargets"]["responses"][200]["content"]["application/json"];
export type PublicationList =
  operations["listPublications"]["responses"][200]["content"]["application/json"];
export type CreatePublication = components["schemas"]["CreatePublication"];
export type Publication = components["schemas"]["Publication"];

type ListOptions = NonNullable<operations["listDocuments"]["parameters"]["query"]>;
type CreateDocument = operations["createDocument"]["requestBody"]["content"]["application/json"];
type SaveDocument = operations["saveDocument"]["requestBody"]["content"]["application/json"];
type SaveOutline = operations["saveOutline"]["requestBody"]["content"]["application/json"];
type RestoreRevision = operations["restoreDocument"]["requestBody"]["content"]["application/json"];
type ErrorBody = components["schemas"]["ApiError"];
type BrowserSession = components["schemas"]["BrowserSession"];
export type AccountSummary = components["schemas"]["AccountSummary"];
type CreateAccount = components["schemas"]["CreateAccount"];
type UpdateAccount = components["schemas"]["UpdateAccount"];
type ReplaceAccountPassword = components["schemas"]["ReplaceAccountPassword"];
type ChangeOwnPassword = components["schemas"]["ChangeOwnPassword"];
export type WorkspaceMember = components["schemas"]["WorkspaceMember"];
type SetWorkspaceMember = components["schemas"]["SetWorkspaceMember"];

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
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    body?:
      | CreateDocument
      | SaveDocument
      | SaveOutline
      | RestoreRevision
      | DevicePreferences
      | AiTask
      | AiConfirm
      | CreateWorkspace
      | UpdateWorkspace
      | RenameWorkspacePath
      | DeliveryInput
      | NewDeliveryToken
      | CreateSnapshot
      | SaveBackupSettings
      | CreatePublication
      | CreateAccount
      | UpdateAccount
      | ReplaceAccountPassword
      | ChangeOwnPassword
      | SetWorkspaceMember
      | { operationId: string };
  },
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    signal: signal ?? null,
    credentials: "same-origin",
    ...(write && { method: write.method }),
    ...(write?.body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(write.body),
    }),
  });
  if (response.status === 204) return undefined as T;
  if (response.ok) return (await response.json()) as T;

  throw await responseError(response);
}

async function responseError(response: Response) {
  const error = (await response.json().catch(() => null)) as Partial<ErrorBody> | null;
  return new ApiError(
    response.status,
    error?.code ?? "request_failed",
    error?.message ?? `Request failed (${response.status})`,
    error?.currentRevision,
  );
}

const workspacePath = (workspace: string) => `/workspaces/${encodeURIComponent(workspace)}`;
const workspaceDocuments = (workspace: string) => `${workspacePath(workspace)}/documents`;
const snapshotPath = (id: string) => `/snapshots/${encodeURIComponent(id)}`;
const documentPath = (document: string) => `/documents/${encodeURIComponent(document)}`;

const operationPath = (id: string) => `/ai/operations/${encodeURIComponent(id)}`;
const accountPath = (username: string) => `/accounts/${encodeURIComponent(username)}`;
const membersPath = (workspace: string) => `${workspacePath(workspace)}/members`;

export const api = {
  getSession(signal?: AbortSignal) {
    return request<BrowserSession>("/session", signal);
  },
  listAccounts(signal?: AbortSignal) {
    return request<AccountSummary[]>("/accounts", signal);
  },
  createAccount(body: CreateAccount) {
    return request<AccountSummary>("/accounts", undefined, { method: "POST", body });
  },
  updateAccount(username: string, body: UpdateAccount) {
    return request<AccountSummary>(accountPath(username), undefined, { method: "PATCH", body });
  },
  replaceAccountPassword(username: string, body: ReplaceAccountPassword) {
    return request<void>(`${accountPath(username)}/password`, undefined, { method: "PUT", body });
  },
  revokeAccountSessions(username: string) {
    return request<void>(`${accountPath(username)}/sessions/revoke`, undefined, { method: "POST" });
  },
  changeOwnPassword(body: ChangeOwnPassword) {
    return request<void>("/session/password", undefined, { method: "PUT", body });
  },
  listWorkspaceMembers(workspace: string, signal?: AbortSignal) {
    return request<WorkspaceMember[]>(membersPath(workspace), signal);
  },
  setWorkspaceMember(workspace: string, username: string, body: SetWorkspaceMember) {
    return request<WorkspaceMember[]>(
      `${membersPath(workspace)}/${encodeURIComponent(username)}`,
      undefined,
      { method: "PUT", body },
    );
  },
  removeWorkspaceMember(workspace: string, username: string) {
    return request<WorkspaceMember[]>(
      `${membersPath(workspace)}/${encodeURIComponent(username)}`,
      undefined,
      { method: "DELETE" },
    );
  },
  listWorkspaces(signal?: AbortSignal) {
    return request<Workspace[]>("/workspaces", signal);
  },
  createWorkspace(body: CreateWorkspace) {
    return request<Workspace>("/workspaces", undefined, { method: "POST", body });
  },
  updateWorkspace(workspace: string, body: UpdateWorkspace) {
    return request<Workspace>(workspacePath(workspace), undefined, { method: "PATCH", body });
  },
  renameWorkspacePath(workspace: string, body: RenameWorkspacePath) {
    return request<MutationReceipt>(`${workspacePath(workspace)}/rename`, undefined, {
      method: "POST",
      body,
    });
  },
  createDelivery(workspace: string, body: DeliveryInput) {
    return request<DeliveryReceipt>(`${workspacePath(workspace)}/deliveries`, undefined, {
      method: "POST",
      body,
    });
  },
  listDeliveries(workspace: string, signal?: AbortSignal) {
    return request<DeliveryReceipt[]>(`${workspacePath(workspace)}/deliveries`, signal);
  },
  listDeliveryTokens(workspace: string, signal?: AbortSignal) {
    return request<DeliveryToken[]>(`${workspacePath(workspace)}/delivery-tokens`, signal);
  },
  issueDeliveryToken(workspace: string, body: NewDeliveryToken) {
    return request<IssuedDeliveryToken>(`${workspacePath(workspace)}/delivery-tokens`, undefined, {
      method: "POST",
      body,
    });
  },
  revokeDeliveryToken(workspace: string, id: string) {
    return request<undefined>(
      `${workspacePath(workspace)}/delivery-tokens/${encodeURIComponent(id)}`,
      undefined,
      { method: "DELETE" },
    );
  },
  getBackup(workspace: string, signal?: AbortSignal) {
    return request<BackupSettings>(`${workspacePath(workspace)}/backup`, signal);
  },
  saveBackup(workspace: string, body: SaveBackupSettings) {
    return request<BackupSettings>(`${workspacePath(workspace)}/backup`, undefined, {
      method: "PUT",
      body,
    });
  },
  startBackup(workspace: string, operationId: string) {
    return request<BackupJob>(`${workspacePath(workspace)}/backup/jobs`, undefined, {
      method: "POST",
      body: { operationId },
    });
  },
  getBackupJob(workspace: string, id: string, signal?: AbortSignal) {
    return request<BackupJob>(
      `${workspacePath(workspace)}/backup/jobs/${encodeURIComponent(id)}`,
      signal,
    );
  },
  listPublicationTargets(workspace: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ workspaceId: workspace });
    return request<PublicationTargets>(`/publications/targets?${query}`, signal);
  },
  listPublications(workspace: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ workspaceId: workspace });
    return request<PublicationList>(`/publications?${query}`, signal);
  },
  createPublication(body: CreatePublication) {
    return request<Publication>("/publications", undefined, { method: "POST", body });
  },
  confirmPublication(id: string) {
    return request<Publication>(`/publications/${encodeURIComponent(id)}/confirm`, undefined, {
      method: "POST",
    });
  },
  createSnapshot(workspace: string, body: CreateSnapshot) {
    return request<SnapshotLink>(`${workspacePath(workspace)}/snapshots`, undefined, {
      method: "POST",
      body,
    });
  },
  async getSnapshot(id: string, documentId?: string, signal?: AbortSignal) {
    const query = documentId ? `?${new URLSearchParams({ documentId })}` : "";
    const response = await fetch(`/api/v1${snapshotPath(id)}${query}`, {
      signal: signal ?? null,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response);
    return {
      snapshot: (await response.json()) as Snapshot,
      offline: response.headers.get("X-Librarian-Offline") === "1",
    };
  },
  logout() {
    return request<undefined>("/session/logout", undefined, { method: "POST" });
  },
  revokeSnapshot(id: string) {
    return request<undefined>(snapshotPath(id), undefined, { method: "DELETE" });
  },
  workspaceAsset(workspace: string, path: string) {
    return `/api/v1${workspacePath(workspace)}/assets/${encodeFilePath(path)}`;
  },
  snapshotAsset(id: string, path: string) {
    return `/api/v1${snapshotPath(id)}/assets/${encodeFilePath(path)}`;
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
  listAiOperations(workspace: string, document: string | undefined, signal?: AbortSignal) {
    const query = new URLSearchParams({ workspaceId: workspace });
    if (document) query.set("documentId", document);
    return request<AiOperation[]>(`/ai/operations?${query.toString()}`, signal);
  },
  createAiOperation(input: AiTask, signal?: AbortSignal) {
    return request<AiOperation>("/ai/operations", signal, { method: "POST", body: input });
  },
  async readAiEvents(id: string, after: number, signal: AbortSignal) {
    const response = await fetch(`/api/v1${operationPath(id)}/events`, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/event-stream", "Last-Event-ID": String(after) },
    });
    if (!response.ok) throw await responseError(response);
    return response.text();
  },
  getAiOperation(id: string, signal?: AbortSignal) {
    return request<AiOperation>(operationPath(id), signal);
  },
  getAiOperationDiff(id: string, path: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ path });
    return request<AiOperationDiff>(`${operationPath(id)}/diff?${query.toString()}`, signal);
  },
  confirmAiOperation(id: string, confirmationId: string) {
    return request<AiOperation>(`${operationPath(id)}/confirm`, undefined, {
      method: "POST",
      body: { confirmationId },
    });
  },
  undoAiOperation(id: string) {
    return request<MutationReceipt>(`${operationPath(id)}/undo`, undefined, { method: "POST" });
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

function encodeFilePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}
