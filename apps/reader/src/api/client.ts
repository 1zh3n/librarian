import type { components, operations } from "./schema.gen";

export type Workspace = components["schemas"]["Workspace"];
export type DocumentSummary = components["schemas"]["DocumentSummary"];
export type DocumentSnapshot = components["schemas"]["DocumentSnapshot"];
export type DocumentReferences = components["schemas"]["DocumentReferences"];
export type SearchHit = components["schemas"]["SearchHit"];
export type OutlineSnapshot = components["schemas"]["OutlineSnapshot"];
export type DocumentHistory = components["schemas"]["DocumentHistory"];
export type VersionDiff = components["schemas"]["VersionDiff"];
export type RestoredDocument = components["schemas"]["RestoredDocument"];
export type DevicePreferences = components["schemas"]["DevicePreferences"];
export type AiDiscoveryInput = components["schemas"]["DraftAiDiscovery"];
export type AiSettingsView = components["schemas"]["AiSettingsView"];
export type AiConnection = components["schemas"]["AiConnection"];
export type ModelSelection = components["schemas"]["ModelSelection"];
export type ThinkingSelection = components["schemas"]["ThinkingSelection"];
export type CreateAiConnection = components["schemas"]["CreateAiConnection"];
export type UpdateAiConnection = components["schemas"]["UpdateAiConnection"];
export type ManagedActivation = components["schemas"]["ManagedActivation"];
export type AiProbeInput = components["schemas"]["AiProbeInput"];
export type AiProbe = components["schemas"]["AiProbe"];
export type AiDiscovery = components["schemas"]["AiDiscovery"];
export type DiscoveredModel = components["schemas"]["DiscoveredModel"];
export type ConversationScope = components["schemas"]["ConversationScope"];
export type ConversationView = components["schemas"]["ConversationView"];
export type CreateTurn = components["schemas"]["CreateTurn"];
export type TurnView = components["schemas"]["TurnView"];
export type ConversationPage = components["schemas"]["ConversationPage"];
export type TurnPage = components["schemas"]["TurnPage"];
export type AiMaterialSource = components["schemas"]["AiMaterialSource"];
export type AiMaterialView = components["schemas"]["AiMaterialView"];
export type AiSegmentLocation = components["schemas"]["AiSegmentLocation"];
export type AiMaterialSegment = components["schemas"]["AiMaterialSegment"];
export type AiOperationInput = components["schemas"]["AiOperationInput"];
export type AiTask = components["schemas"]["AiTask"];
export type AiContext = components["schemas"]["AiContext"];
export type AiOperation = components["schemas"]["AiOperation"];
export type AiWorkspaceManagementReceipt = components["schemas"]["AiWorkspaceManagementReceipt"];
export type AiTransferPreview = components["schemas"]["AiTransferPreview"];
export type AiTransferReceipt = components["schemas"]["AiTransferReceipt"];
export type DocumentMemberLink = components["schemas"]["DocumentMemberLink"];
export type WorkspaceImportRequest = components["schemas"]["WorkspaceImportRequest"];
export type WorkspaceImportReceipt = components["schemas"]["WorkspaceImportReceipt"];
export type MutationReceipt = components["schemas"]["MutationReceipt"];
type AiOperationDiff = components["schemas"]["AiOperationDiff"];
type AiConfirm = components["schemas"]["AiConfirmRequest"];

type CreateWorkspace = components["schemas"]["CreateWorkspace"];
type UpdateWorkspace = components["schemas"]["UpdateWorkspace"];
export type RenameWorkspacePath = components["schemas"]["RenameWorkspacePaths"];
export type FileActionRequest = components["schemas"]["FileActionRequest"];
export type FileActionPreview = components["schemas"]["FileActionPreview"];
export type DeletedFileAction = components["schemas"]["DeletedFileAction"];
export type FileActionResult = components["schemas"]["FileActionResult"];
export type WorkspaceSettings = Omit<CreateWorkspace, "origin">;
export type DeliveryManifest = components["schemas"]["DeliveryManifest"];
type DeliveryInput = components["schemas"]["DeliveryRequest"];
export type DeliveryReceipt = components["schemas"]["DeliveryReceipt"];
type NewDeliveryToken = components["schemas"]["NewDeliveryToken"];
export type DeliveryToken = components["schemas"]["DeliveryToken"];
type IssuedDeliveryToken = components["schemas"]["IssuedDeliveryToken"];
export type CreateSnapshot = components["schemas"]["CreateSnapshot"];
export type SnapshotLink = components["schemas"]["SnapshotLink"];
export type SnapshotLinkSummary = components["schemas"]["SnapshotLinkSummary"];
export type Snapshot = components["schemas"]["ReaderSnapshot"];
export type AssetUpload = components["schemas"]["AssetUpload"];

export type BackupSettings = components["schemas"]["BackupSettings"];
export type BackupJob = components["schemas"]["BackupJob"];
export type SaveBackupSettings = components["schemas"]["SaveBackupSettings"];
type PublicationTargets =
  operations["listPublicationTargets"]["responses"][200]["content"]["application/json"];
export type PublicationList =
  operations["listPublications"]["responses"][200]["content"]["application/json"];
export type CreatePublication = components["schemas"]["CreatePublication"];
export type Publication = components["schemas"]["Publication"];
type ConfirmPublication = components["schemas"]["ConfirmPublication"];

type ListOptions = NonNullable<operations["listDocuments"]["parameters"]["query"]>;
type CreateDocument = operations["createDocument"]["requestBody"]["content"]["application/json"];
type SaveDocument = operations["saveDocument"]["requestBody"]["content"]["application/json"];
type SaveOutline = operations["saveOutline"]["requestBody"]["content"]["application/json"];
type RestoreRevision = operations["restoreDocument"]["requestBody"]["content"]["application/json"];
type ErrorBody = components["schemas"]["ApiError"];
type BrowserSession = components["schemas"]["BrowserSession"];
export type AccountSummary = components["schemas"]["AccountSummary"];
export type AccountSession = components["schemas"]["AccountSession"];
type AccountSessionList = components["schemas"]["AccountSessionList"];
type RevokedSessions = components["schemas"]["RevokedSessions"];
export type McpSettings = components["schemas"]["McpSettings"];
export type McpGrant = components["schemas"]["McpGrant"];
type CreateAccount = components["schemas"]["CreateAccount"];
type UpdateAccount = components["schemas"]["UpdateAccount"];
type ReplaceAccountPassword = components["schemas"]["ReplaceAccountPassword"];
type ChangeOwnPassword = components["schemas"]["ChangeOwnPassword"];
export type TotpStatus = components["schemas"]["TotpStatus"];
export type TotpStart = components["schemas"]["TotpStart"];
export type TotpEnabled = components["schemas"]["TotpEnabled"];
export type TotpVerifyInput = components["schemas"]["TotpVerify"];
export type StepUpToken = components["schemas"]["StepUpToken"];
export type InviteWorkspace = components["schemas"]["InviteWorkspace"];
export type InvitePreview = components["schemas"]["InvitePreview"];
export type InviteSummary = components["schemas"]["InviteSummary"];
export type CreatedInvite = components["schemas"]["CreatedInvite"];
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

const accessMessages = new Map([
  ["workspace_manage_required", "这项操作需要工作区管理权限。"],
  ["administrator_required", "这项操作需要管理员权限。"],
  ["read_only", "当前账号只有读取权限。"],
  ["revisions_read_only", "这个工作区未启用可写版本记录。"],
  ["workspace_owner_protected", "工作区创建者的权限受到保护。"],
]);

export function aiAccessMessage(error: unknown) {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 401) return "请重新登录后继续。";
  if (error.status === 404) return "内容已删除或不在当前账号的访问范围内。";
  return (
    accessMessages.get(error.code) ??
    (error.status === 403 ? "当前账号没有执行这项操作的权限。" : undefined)
  );
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
      | AiOperationInput
      | components["schemas"]["AiDiscoveryInput"]
      | ConversationScope
      | CreateTurn
      | CreateAiConnection
      | UpdateAiConnection
      | ManagedActivation
      | AiProbeInput
      | { selection: ModelSelection | null }
      | { enabled: boolean }
      | AiConfirm
      | CreateWorkspace
      | UpdateWorkspace
      | RenameWorkspacePath
      | FileActionRequest
      | components["schemas"]["FileActionApply"]
      | components["schemas"]["WorkspaceFolder"]
      | DeliveryInput
      | WorkspaceImportRequest
      | NewDeliveryToken
      | CreateSnapshot
      | SaveBackupSettings
      | CreatePublication
      | ConfirmPublication
      | CreateAccount
      | UpdateAccount
      | ReplaceAccountPassword
      | ChangeOwnPassword
      | TotpVerifyInput
      | { code: string }
      | {
          username: string;
          admin: boolean;
          role: "read" | "write";
          workspaceIds: string[];
          expiresInDays: number;
        }
      | { password: string; totpSecret: string; code: string }
      | SetWorkspaceMember
      | components["schemas"]["FileActionUndo"];
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

export function discoverAiModels(
  input: components["schemas"]["AiDiscoveryInput"],
  signal?: AbortSignal,
): Promise<AiDiscovery> {
  return request<AiDiscovery>("/ai/settings/discover", signal, { method: "POST", body: input });
}

export function getAiSettings(signal?: AbortSignal) {
  return request<AiSettingsView>("/ai/settings", signal);
}

export function createAiConnection(input: CreateAiConnection) {
  return request<{ id: string; version: number }>("/ai/settings/connections", undefined, {
    method: "POST",
    body: input,
  });
}

export function updateAiConnection(id: string, input: UpdateAiConnection) {
  return request<void>(`/ai/settings/connections/${encodeURIComponent(id)}`, undefined, {
    method: "PATCH",
    body: input,
  });
}

export function removeAiConnection(id: string, expectedVersion: number) {
  return request<void>(
    `/ai/settings/connections/${encodeURIComponent(id)}?expectedVersion=${expectedVersion}`,
    undefined,
    { method: "DELETE" },
  );
}

export function setAiPreference(selection: ModelSelection | null) {
  return request<void>("/ai/settings/preference", undefined, {
    method: "PUT",
    body: { selection },
  });
}

export function setAiDefault(selection: ModelSelection) {
  return request<void>("/ai/settings/default", undefined, { method: "PUT", body: { selection } });
}

export function setAiGlobalEnabled(enabled: boolean) {
  return request<void>("/ai/settings/global-enabled", undefined, {
    method: "PUT",
    body: { enabled },
  });
}

export function activateManagedAi(input: ManagedActivation) {
  return request<{ activationId: string }>("/ai/settings/managed-activation", undefined, {
    method: "POST",
    body: input,
  });
}

export function startAiProbe(connectionId: string, input: AiProbeInput) {
  return request<AiProbe>(
    `/ai/settings/connections/${encodeURIComponent(connectionId)}/probe`,
    undefined,
    { method: "POST", body: input },
  );
}

export function getAiProbe(id: string, signal?: AbortSignal) {
  return request<AiProbe>(`/ai/settings/probes/${encodeURIComponent(id)}`, signal);
}

const conversationPath = (id: string) => `/ai/conversations/${encodeURIComponent(id)}`;
const materialsPath = (id: string) => `${conversationPath(id)}/materials`;

function checkConversationScope(scope: ConversationScope) {
  if ("scope" in scope) {
    if ("workspaceId" in scope || ("documentId" in scope && scope.documentId != null))
      throw new ApiError(
        422,
        "invalid_request",
        "Global conversations cannot specify a workspace or document",
      );
  } else if (!scope.workspaceId) throw new ApiError(422, "invalid_request", "Missing workspace ID");
}

function scopeQuery(scope: ConversationScope) {
  checkConversationScope(scope);
  if ("scope" in scope) return new URLSearchParams({ scope: scope.scope });
  const query = new URLSearchParams({ workspaceId: scope.workspaceId });
  if (scope.documentId) query.set("documentId", scope.documentId);
  return query;
}

export async function listConversations(
  scope: ConversationScope,
  cursor?: string,
  signal?: AbortSignal,
) {
  const q = scopeQuery(scope);
  if (cursor) q.set("cursor", cursor);
  return request<ConversationPage>(`/ai/conversations?${q}`, signal);
}

export async function createConversation(scope: ConversationScope) {
  checkConversationScope(scope);
  return request<ConversationView>("/ai/conversations", undefined, {
    method: "POST",
    body: scope,
  });
}

export function getConversation(id: string, signal?: AbortSignal) {
  return request<ConversationView>(conversationPath(id), signal);
}

export function deleteConversation(id: string) {
  return request<void>(conversationPath(id), undefined, { method: "DELETE" });
}

export function listTurns(id: string, cursor?: string, signal?: AbortSignal) {
  return request<TurnPage>(
    `${conversationPath(id)}/turns${cursor ? "?" + new URLSearchParams({ cursor }) : ""}`,
    signal,
  );
}

export function createTurn(id: string, input: CreateTurn) {
  return request<TurnView>(`${conversationPath(id)}/turns`, undefined, {
    method: "POST",
    body: input,
  });
}

export function cancelTurn(id: string, turnId: string) {
  return request<TurnView>(
    `${conversationPath(id)}/turns/${encodeURIComponent(turnId)}/cancel`,
    undefined,
    { method: "POST" },
  );
}

export function listAiMaterials(id: string, signal?: AbortSignal) {
  return request<AiMaterialView[]>(materialsPath(id), signal);
}

export async function uploadAiMaterial(id: string, file: File, signal?: AbortSignal) {
  const ext = file.name.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    txt: "text/plain",
    md: "text/markdown",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  const response = await fetch(
    `/api/v1${materialsPath(id)}?${new URLSearchParams({ name: file.name })}`,
    {
      method: "POST",
      headers: { "Content-Type": types[ext ?? ""] ?? file.type },
      body: file,
      signal: signal ?? null,
      credentials: "same-origin",
    },
  );
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as AiMaterialView;
}

export function removeAiMaterial(id: string, material: string) {
  return request<void>(`${materialsPath(id)}/${encodeURIComponent(material)}`, undefined, {
    method: "DELETE",
  });
}

export function readAiMaterialSegment(
  id: string,
  material: string,
  segment: string,
  signal?: AbortSignal,
) {
  return request<AiMaterialSegment>(
    `${materialsPath(id)}/${encodeURIComponent(material)}/segments/${encodeURIComponent(segment)}`,
    signal,
  );
}

export const api = {
  getSession(signal?: AbortSignal) {
    return request<BrowserSession>("/session", signal);
  },
  listAccounts(signal?: AbortSignal) {
    return request<AccountSummary[]>("/accounts", signal);
  },
  getMcpSettings(signal?: AbortSignal) {
    return request<McpSettings>("/mcp/settings", signal);
  },
  setMcpEnabled(enabled: boolean) {
    return request<McpSettings>("/mcp/settings", undefined, {
      method: "PUT",
      body: { enabled },
    });
  },
  listMcpGrants(signal?: AbortSignal) {
    return request<McpGrant[]>("/mcp/grants", signal);
  },
  revokeMcpGrant(id: string) {
    return request<void>(`/mcp/grants/${encodeURIComponent(id)}`, undefined, {
      method: "DELETE",
    });
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
  listAccountSessions(signal?: AbortSignal) {
    return request<AccountSessionList>("/session/sessions", signal);
  },
  revokeAccountSession(id: string) {
    return request<void>(`/session/sessions/${encodeURIComponent(id)}`, undefined, {
      method: "DELETE",
    });
  },
  revokeOtherAccountSessions() {
    return request<RevokedSessions>("/session/sessions/revoke-others", undefined, {
      method: "POST",
    });
  },
  changeOwnPassword(body: ChangeOwnPassword) {
    return request<void>("/session/password", undefined, { method: "PUT", body });
  },
  getTotpStatus(signal?: AbortSignal) {
    return request<TotpStatus>("/session/totp", signal);
  },
  startTotp() {
    return request<TotpStart>("/session/totp/start", undefined, { method: "POST" });
  },
  verifyTotp(body: TotpVerifyInput) {
    return request<TotpEnabled>("/session/totp/verify", undefined, { method: "POST", body });
  },
  disableTotp(body: { code: string }) {
    return request<void>("/session/totp/disable", undefined, { method: "POST", body });
  },
  stepUp(code: string) {
    return request<StepUpToken>("/session/step-up", undefined, {
      method: "POST",
      body: { code },
    });
  },
  resetTotp(username: string) {
    return request<void>(`${accountPath(username)}/totp/reset`, undefined, { method: "POST" });
  },
  listInvites(signal?: AbortSignal) {
    return request<InviteSummary[]>("/invites", signal);
  },
  createInvite(body: {
    username: string;
    admin: boolean;
    role: "read" | "write";
    workspaceIds: string[];
    expiresInDays: number;
  }) {
    return request<CreatedInvite>("/invites", undefined, { method: "POST", body });
  },
  revokeInvite(id: string) {
    return request<void>(`/invites/${encodeURIComponent(id)}`, undefined, { method: "DELETE" });
  },
  getInvite(token: string, signal?: AbortSignal) {
    return request<InvitePreview>(`/invites/${encodeURIComponent(token)}`, signal);
  },
  acceptInvite(token: string, body: { password: string; totpSecret: string; code: string }) {
    return request<{ recoveryCodes: string[] }>(
      `/invites/${encodeURIComponent(token)}/accept`,
      undefined,
      { method: "POST", body },
    );
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
  folders(workspace: string, signal?: AbortSignal) {
    return request<components["schemas"]["WorkspaceFolders"]>(
      `${workspacePath(workspace)}/folders`,
      signal,
    );
  },
  createFolder(workspace: string, path: string) {
    return request<components["schemas"]["WorkspaceFolder"]>(
      `${workspacePath(workspace)}/folders`,
      undefined,
      {
        method: "POST",
        body: { path },
      },
    );
  },
  previewFileAction(workspace: string, body: FileActionRequest, signal?: AbortSignal) {
    return request<FileActionPreview>(`${workspacePath(workspace)}/file-actions/preview`, signal, {
      method: "POST",
      body,
    });
  },
  applyFileAction(workspace: string, body: components["schemas"]["FileActionApply"]) {
    return request<FileActionResult>(`${workspacePath(workspace)}/file-actions/apply`, undefined, {
      method: "POST",
      body,
    });
  },
  deletedFileActions(workspace: string, signal?: AbortSignal) {
    return request<components["schemas"]["DeletedFileActions"]>(
      `${workspacePath(workspace)}/file-actions/deleted`,
      signal,
    );
  },
  undoFileAction(workspace: string, operationId: string, targetPath?: string) {
    return request<FileActionResult>(`${workspacePath(workspace)}/file-actions/undo`, undefined, {
      method: "POST",
      body: targetPath === undefined ? { operationId } : { operationId, targetPath },
    });
  },
  importWorkspaceFiles(workspace: string, body: WorkspaceImportRequest, signal?: AbortSignal) {
    return request<WorkspaceImportReceipt>(`${workspacePath(workspace)}/imports`, signal, {
      method: "POST",
      body,
    });
  },
  getWorkspaceImport(workspace: string, operationId: string, signal?: AbortSignal) {
    return request<WorkspaceImportReceipt>(
      `${workspacePath(workspace)}/imports/${encodeURIComponent(operationId)}`,
      signal,
    );
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
  confirmPublication(id: string, stepUpToken?: string) {
    return request<Publication>(`/publications/${encodeURIComponent(id)}/confirm`, undefined, {
      method: "POST",
      body: stepUpToken ? { stepUpToken } : {},
    });
  },
  listSnapshots(workspace: string, signal?: AbortSignal) {
    return request<SnapshotLinkSummary[]>(`${workspacePath(workspace)}/snapshots`, signal);
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
  async uploadWorkspaceAsset(workspace: string, body: FormData, signal?: AbortSignal) {
    const response = await fetch(`/api/v1${workspacePath(workspace)}/assets`, {
      method: "POST",
      body,
      credentials: "same-origin",
      signal: signal ?? null,
    });
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as AssetUpload;
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
  getDocumentReferences(document: string, signal?: AbortSignal) {
    return request<DocumentReferences>(`${documentPath(document)}/references`, signal);
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
  async listAiOperations(
    workspace: string | ConversationScope,
    document?: string,
    signal?: AbortSignal,
  ) {
    const scope =
      typeof workspace === "string"
        ? { workspaceId: workspace, ...(document && { documentId: document }) }
        : workspace;
    return request<AiOperation[]>(`/ai/operations?${scopeQuery(scope)}`, signal);
  },
  async createAiOperation(input: AiOperationInput, signal?: AbortSignal) {
    checkConversationScope(input);
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
  cancelAiConfirmation(id: string, confirmationId: string) {
    return request<AiOperation>(`${operationPath(id)}/cancel`, undefined, {
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
