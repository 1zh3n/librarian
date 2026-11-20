import { queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { DocumentSummary } from "./client";

export const workspaceKeys = {
  all: ["workspaces"] as const,
  workspace: (workspace: string) => ["workspaces", workspace] as const,
  documents: (workspace: string) => ["workspaces", workspace, "documents"] as const,
  document: (workspace: string, document: string) =>
    ["workspaces", workspace, "document", document] as const,
  outline: (workspace: string, document: string) =>
    ["workspaces", workspace, "document", document, "outline"] as const,
  search: (workspace: string, query: string) => ["workspaces", workspace, "search", query] as const,
};

export const workspacesQuery = queryOptions({
  queryKey: workspaceKeys.all,
  queryFn: ({ signal }) => api.listWorkspaces(signal),
});

export function documentsQuery(workspace: string) {
  return queryOptions({
    queryKey: workspaceKeys.documents(workspace),
    queryFn: async ({ signal }) => {
      const documents: DocumentSummary[] = [];
      let after: string | undefined;
      const limit = 500;
      for (;;) {
        const batch = await api.listDocuments(
          workspace,
          after ? { limit, after } : { limit },
          signal,
        );
        documents.push(...batch);
        after = batch.at(-1)?.path;
        if (batch.length < limit || after === undefined) return documents;
      }
    },
  });
}

export function documentQuery(workspace: string, document: string) {
  return queryOptions({
    queryKey: workspaceKeys.document(workspace, document),
    queryFn: async ({ signal }) => {
      const snapshot = await api.getDocument(document, signal);
      if (snapshot.document.workspaceId !== workspace) {
        throw new ApiError(404, "not_found", "Document belongs to a different workspace");
      }
      return snapshot;
    },
  });
}

export function searchQuery(workspace: string, query: string) {
  return queryOptions({
    queryKey: workspaceKeys.search(workspace, query),
    queryFn: ({ signal }) => api.searchDocuments(workspace, query, signal),
    retry: (count, error) => error instanceof ApiError && error.status === 503 && count < 4,
    retryDelay: 250,
  });
}

export function outlineQuery(workspace: string, document: string) {
  return queryOptions({
    queryKey: workspaceKeys.outline(workspace, document),
    queryFn: ({ signal }) => api.getOutline(document, signal),
  });
}
