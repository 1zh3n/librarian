import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api, ApiError, type RenameWorkspacePath } from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";

type Paths = Omit<RenameWorkspacePath, "operationId">;

export function useRenamePath(workspace: string) {
  const client = useQueryClient();
  const previous = useRef<(Paths & { operationId: string; workspace: string }) | undefined>(
    undefined,
  );
  return useMutation({
    mutationFn: (paths: Paths) => {
      const last = previous.current;
      const id =
        last?.workspace === workspace &&
        last.from === paths.from &&
        last.to === paths.to &&
        last.expectedDocumentId === paths.expectedDocumentId
          ? last.operationId
          : operationId();
      previous.current = { workspace, ...paths, operationId: id };
      return api.renameWorkspacePath(workspace, { ...paths, operationId: id });
    },
    onSuccess: async () => {
      previous.current = undefined;
      await client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        void client.invalidateQueries({ queryKey: workspaceKeys.all, exact: true });
      } else if (error instanceof ApiError && error.code === "rename_source_changed") {
        void client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
      }
    },
  });
}
