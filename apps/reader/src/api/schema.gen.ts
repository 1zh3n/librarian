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
}
