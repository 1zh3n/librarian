// Generated from api/librarian.openapi.json. Run npm run api:generate -w @librarian/reader.

export interface paths {
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
    post?: never;
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
    get?: never;
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
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    Workspace: {
      id: string;
      spaceId: string;
      name: string;
      /** @enum {string} */
      origin: "native";
      /** @enum {string} */
      retention: "persistent";
      /** @enum {string} */
      revisionMode: "managed" | "repository" | "disabled";
      defaults: {
        outlineEnabled: boolean;
      };
      canWrite: boolean;
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
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
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
}
