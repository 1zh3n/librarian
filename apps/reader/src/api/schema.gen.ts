// Generated from api/librarian.openapi.json. Run npm run api:generate -w @librarian/reader.

export interface paths {
  "/session": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getSession"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/session/logout": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["logoutSession"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getBackupSettings"];
    put: operations["saveBackupSettings"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup/jobs": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startBackupJob"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/backup/jobs/{job}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getBackupJob"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/targets": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPublicationTargets"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listPublications"];
    put?: never;
    post: operations["createPublication"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/{publication}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPublication"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/publications/{publication}/confirm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["confirmPublication"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["health"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaces"];
    put?: never;
    post: operations["createWorkspace"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/documents": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    get: operations["listDocuments"];
    put?: never;
    post: operations["createDocument"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getDocument"];
    put: operations["saveDocument"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/search": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    get: operations["searchDocuments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/outline": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getOutline"];
    put: operations["saveOutline"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/revisions": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get: operations["getDocumentHistory"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/revisions/{commit}/diff": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
        commit: string;
      };
      cookie?: never;
    };
    get: operations["getVersionDiff"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/documents/{document}/restore": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["restoreDocument"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/devices/{device}": {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    get: operations["getDevicePreferences"];
    put: operations["saveDevicePreferences"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAiOperations"];
    put?: never;
    post: operations["createAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getAiOperation"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["replayAiEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/confirm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["confirmAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/undo": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["undoAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["claimAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["readAiSource"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/result": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["finishAiOperation"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/operations/{operation}/diff": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["diffAiOperationFile"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/documents": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["discoverAiDocuments"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["reportAiRunnerEvent"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/renew": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renewAiLease"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/ai/runner/claims/{lease}/fail": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["failAiOperation"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch: operations["updateWorkspace"];
    trace?: never;
  };
  "/workspaces/{workspace}/rename": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["renameWorkspacePaths"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/deliveries": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listWorkspaceDeliveries"];
    put?: never;
    post: operations["deliverWorkspaceFiles"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/delivery-tokens": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listDeliveryTokens"];
    put?: never;
    post: operations["issueDeliveryToken"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/delivery-tokens/{token}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["revokeDeliveryToken"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/assets/{path}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["readWorkspaceAttachment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/workspaces/{workspace}/snapshots": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["createSnapshot"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/snapshots/{snapshot}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getReaderSnapshot"];
    put?: never;
    post?: never;
    delete: operations["revokeSnapshot"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/snapshots/{snapshot}/assets/{path}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["readSnapshotAttachment"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    BrowserSession: {
      username: string;
      cacheId: string;
    };
    ConfiguredTarget: {
      id: string;
      label: string;
    };
    SaveBackupSettings: {
      targetId: string | null;
      /** @enum {string} */
      mode: "grouped" | "each-operation";
    };
    BackupSettings: {
      targets: components["schemas"]["ConfiguredTarget"][];
      targetId: string | null;
      /** @enum {string} */
      mode: "grouped" | "each-operation";
      lastJob: components["schemas"]["BackupJob"] | null;
    };
    BackupJob: {
      id: string;
      workspaceId: string;
      /** @enum {string} */
      status: "queued" | "succeeded" | "failed";
      sourceCommitId: string;
      commitId: string | null;
      message: string | null;
    };
    CreatePublication: {
      workspaceId: string;
      targetId: string;
      commitId: string;
      documentIds: string[];
      /** Format: uuid */
      operationId: string;
      /** @default false */
      confirm: boolean;
    };
    Publication: {
      /** Format: uuid */
      id: string;
      workspaceId: string;
      targetId: string;
      documentIds: string[];
      /** @enum {string} */
      status: "pending" | "published" | "failed";
      sourceCommitId: string;
      publishedCommitId: string | null;
      url: string | null;
      message: string | null;
    };
    Workspace: {
      id: string;
      spaceId: string;
      name: string;
      /** @enum {string} */
      origin: "native" | "delivery";
      /** @enum {string} */
      retention: "persistent" | "temporary";
      /** @enum {string} */
      revisionMode: "managed" | "repository" | "disabled";
      defaults: {
        outlineEnabled: boolean;
      };
      canWrite: boolean;
      expiresAt: number | null;
      canManage: boolean;
    };
    DocumentSummary: {
      id: string;
      workspaceId: string;
      path: string;
      title: string;
      outlineEnabled: boolean;
    };
    DocumentSnapshot: {
      document: components["schemas"]["DocumentSummary"];
      markdown: string;
      revision: string;
    };
    WriteMarkdown: {
      markdown: string;
      baseRevision: string;
    };
    CreateDocument: {
      path: string;
      markdown: string;
      baseRevision: null;
    };
    ApiError: {
      code: string;
      message: string;
      currentRevision?: string;
    };
    SearchHit: {
      document: components["schemas"]["DocumentSummary"];
      excerpt: string;
    };
    OutlineSnapshot: {
      markdown: string;
      revision: string | null;
    };
    SaveOutline: {
      markdown: string;
      baseRevision: string | null;
    };
    RevisionEntry: {
      commitId: string;
      timestamp: number;
      author: string;
      message: string;
      added: number;
      removed: number;
    };
    DocumentHistory: {
      /** @enum {string} */
      mode: "managed" | "repository";
      revisions: components["schemas"]["RevisionEntry"][];
      uncommitted: boolean;
      more: boolean;
    };
    VersionDiff: {
      commitId: string;
      diff: string;
      markdown: string | null;
    };
    RestoreRevision: {
      commitId: string;
      baseRevision: string;
    };
    RestoredDocument: {
      commitId: string;
      snapshot: components["schemas"]["DocumentSnapshot"];
    };
    DevicePreferences: {
      /** @enum {string} */
      theme: "system" | "light" | "dark";
      /** @enum {string} */
      font: "serif" | "sans";
      /** @enum {string} */
      layout: "reading" | "writing" | "research" | "review" | "custom";
      fontSize: number;
      lineHeight: number;
      measure: number;
      navigation: boolean | null;
      sidebarWidth: number;
      toolsWidth: number;
      eink: boolean;
      reduceMotion: boolean;
      focusKey: string;
    };
    /** @enum {string} */
    AiMode: "chat" | "edit";
    AiContext: {
      documentId: string;
      revision?: string | null;
      from?: number;
      to?: number;
      blockId?: string | null;
    };
    AiTask: {
      workspaceId: string;
      documentId?: string | null;
      mode: components["schemas"]["AiMode"];
      prompt: string;
      context?: components["schemas"]["AiContext"][];
    };
    AiSourceReference: {
      id: string;
      documentId: string;
      path: string;
      revision: string;
      blockId?: string;
      from?: number;
      to?: number;
    };
    MutationFileChange: {
      path: string;
      beforeRevision: string | null;
      revision: string | null;
    };
    MutationReceipt: {
      operationId: string;
      workspaceId: string;
      commitId: string;
      changes: components["schemas"]["MutationFileChange"][];
    };
    AiConfirmation: {
      id: string;
      paths: string[];
    };
    AiOperation: {
      id: string;
      workspaceId: string;
      documentId: string | null;
      mode: components["schemas"]["AiMode"];
      /** @enum {string} */
      status:
        | "queued"
        | "running"
        | "succeeded"
        | "failed"
        | "conflict"
        | "needs_confirmation"
        | "canceled";
      answer: string | null;
      sources: components["schemas"]["AiSourceReference"][];
      commitId: string | null;
      confirmation: components["schemas"]["AiConfirmation"] | null;
      undoCommitId: string | null;
      changes: components["schemas"]["MutationFileChange"][];
    };
    AiClaim: {
      operationId: string;
      leaseId: string;
      expiresAt: number;
      input: components["schemas"]["AiTask"];
    };
    AiSourceRequest: {
      documentId: string;
      outline?: boolean;
      full?: boolean;
    };
    AiSourceData: {
      source: components["schemas"]["AiSourceReference"];
      markdown: string;
    };
    AiFileEdit: {
      path: string;
      baseRevision: string | null;
      markdown: string | null;
    };
    AiRunnerResult: {
      answer: string;
      sourceIds?: string[];
      edits?: components["schemas"]["AiFileEdit"][];
    };
    AiConfirmRequest: {
      confirmationId: string;
    };
    AiOperationDiff: {
      commitId: string;
      path: string;
      diff: string;
    };
    AiRunnerEvent: {
      executorSeq: number;
      /** @enum {string} */
      kind: "progress" | "text_delta";
      text: string;
    };
    AiEventReceipt: {
      sequence: number;
    };
    AiLeaseRenewal: {
      expiresAt: number;
    };
    AiRunnerFailure: {
      text: string;
    };
    CreateWorkspace: {
      name: string;
      /** @enum {string} */
      origin?: "native" | "delivery";
      /** @enum {string} */
      retention?: "persistent" | "temporary";
      expiresAt?: number | null;
    };
    UpdateWorkspace: {
      name?: string;
      /** @enum {string} */
      retention?: "persistent" | "temporary";
      expiresAt?: number | null;
    };
    RenameWorkspacePaths: {
      operationId: string;
      from: string;
      to: string;
    };
    DeliveryManifest: {
      deliveryId: string;
      sourceName: string;
      version?: string | null;
      /** Format: date-time */
      generatedAt?: string | null;
    };
    DeliveryFile: {
      path: string;
      contentBase64: string;
    };
    DeliveryRequest:
      | {
          manifest: components["schemas"]["DeliveryManifest"];
          files: components["schemas"]["DeliveryFile"][];
        }
      | {
          manifest: components["schemas"]["DeliveryManifest"];
          archiveBase64: string;
        };
    DeliveryReceipt: {
      deliveryId: string;
      workspaceId: string;
      operationId: string;
      commitId: string;
      manifest: components["schemas"]["DeliveryManifest"];
      changes: components["schemas"]["MutationFileChange"][];
    };
    DeliveryToken: {
      id: string;
      name: string;
      revoked: boolean;
    };
    NewDeliveryToken: {
      name: string;
    };
    IssuedDeliveryToken: {
      id: string;
      name: string;
      revoked: boolean;
      token: string;
    };
    CreateSnapshot: {
      /** @enum {string} */
      kind: "current" | "release";
      /** @enum {string} */
      audience?: "members" | "share";
      documentIds: string[];
      attachmentPaths?: string[];
      expiresAt?: number | null;
      commitId?: string | null;
    };
    SnapshotLink: {
      id: string;
      url: string;
    };
    SnapshotDocumentSummary: {
      id: string;
      path: string;
      title: string;
    };
    SnapshotDocument: {
      id: string;
      path: string;
      title: string;
      markdown: string;
      revision: string;
    };
    ReaderSnapshot: {
      id: string;
      workspaceId: string;
      /** @enum {string} */
      kind: "current" | "release";
      /** @enum {string} */
      audience: "members" | "share";
      expiresAt: number | null;
      commitId: string | null;
      documents: components["schemas"]["SnapshotDocumentSummary"][];
      document: components["schemas"]["SnapshotDocument"];
      attachmentPaths: string[];
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BrowserSession"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  logoutSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getBackupSettings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveBackupSettings: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveBackupSettings"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupSettings"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  startBackupJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": {
          /** Format: uuid */
          operationId: string;
        };
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupJob"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getBackupJob: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        job: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["BackupJob"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listPublicationTargets: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            targets: components["schemas"]["ConfiguredTarget"][];
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listPublications: {
    parameters: {
      query: {
        workspaceId: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            publications: components["schemas"]["Publication"][];
          };
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createPublication: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreatePublication"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publication: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  confirmPublication: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        publication: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Publication"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  health: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": {
            /** @enum {string} */
            status: "ok";
            version: string;
          };
        };
      };
    };
  };
  listWorkspaces: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateWorkspace"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listDocuments: {
    parameters: {
      query?: {
        after?: string;
        limit?: number;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSummary"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateDocument"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WriteMarkdown"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  searchDocuments: {
    parameters: {
      query: {
        q: string;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Up to twenty matching documents in this workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SearchHit"][];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Superseded search */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Search is busy */
      429: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getOutline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Outline Markdown and content revision, null before creation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OutlineSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveOutline: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SaveOutline"];
      };
    };
    responses: {
      /** @description Outline Markdown and content revision, null before creation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["OutlineSnapshot"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDocumentHistory: {
    parameters: {
      query?: {
        before?: string;
        limit?: number;
      };
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Version history for this document */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentHistory"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getVersionDiff: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
        commit: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Diff and original Markdown for the selected version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["VersionDiff"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  restoreDocument: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        document: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RestoreRevision"];
      };
    };
    responses: {
      /** @description Restored Markdown and new Git commit */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RestoredDocument"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Resource not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Revision conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Base revision required */
      428: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Workspace unavailable */
      503: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getDevicePreferences: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Effective device preferences */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DevicePreferences"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  saveDevicePreferences: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        device: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DevicePreferences"];
      };
    };
    responses: {
      /** @description Saved device preferences */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DevicePreferences"];
        };
      };
      /** @description Sign in required */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Invalid request */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
      /** @description Request failed */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listAiOperations: {
    parameters: {
      query: {
        workspaceId: string;
        documentId?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current account's recent operations in the requested context */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiTask"];
      };
    };
    responses: {
      /** @description Operation registered */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Current operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  replayAiEvents: {
    parameters: {
      query?: never;
      header?: {
        "Last-Event-ID"?: string;
      };
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Finite stream of durable events after the supplied cursor */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "text/event-stream": string;
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  confirmAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiConfirmRequest"];
      };
    };
    responses: {
      /** @description Confirmed operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  undoAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description New reverse version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MutationReceipt"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  claimAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Leased operation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiClaim"];
        };
      };
      /** @description No queued operation */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readAiSource: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiSourceRequest"];
      };
    };
    responses: {
      /** @description Authorized source snapshot */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiSourceData"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  finishAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerResult"];
      };
    };
    responses: {
      /** @description Operation result or confirmation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Operation could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  diffAiOperationFile: {
    parameters: {
      query: {
        path: string;
      };
      header?: never;
      path: {
        operation: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Git diff for a file affected by this operation */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperationDiff"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  discoverAiDocuments: {
    parameters: {
      query?: {
        q?: string;
      };
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accessible document metadata in this task's workspace */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DocumentSummary"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  reportAiRunnerEvent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerEvent"];
      };
    };
    responses: {
      /** @description Durable event sequence */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiEventReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  renewAiLease: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description New execution lease expiration */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiLeaseRenewal"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  failAiOperation: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        lease: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AiRunnerFailure"];
      };
    };
    responses: {
      /** @description Failed operation state */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AiOperation"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  updateWorkspace: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["UpdateWorkspace"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["Workspace"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  renameWorkspacePaths: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RenameWorkspacePaths"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["MutationReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listWorkspaceDeliveries: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryReceipt"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  deliverWorkspaceFiles: {
    parameters: {
      query?: {
        deliveryId?: string;
        sourceName?: string;
        version?: string;
        generatedAt?: string;
      };
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DeliveryRequest"];
        "application/zip": string;
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryReceipt"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  listDeliveryTokens: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["DeliveryToken"][];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  issueDeliveryToken: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["NewDeliveryToken"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["IssuedDeliveryToken"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeDeliveryToken: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        token: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readWorkspaceAttachment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
        path: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Original attachment bytes */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  createSnapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        workspace: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateSnapshot"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["SnapshotLink"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  getReaderSnapshot: {
    parameters: {
      query?: {
        documentId?: string;
      };
      header?: never;
      path: {
        snapshot: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ReaderSnapshot"];
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  revokeSnapshot: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        snapshot: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
  readSnapshotAttachment: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        snapshot: string;
        path: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Original attachment bytes */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
        };
      };
      /** @description Request could not be completed */
      default: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ApiError"];
        };
      };
    };
  };
}
