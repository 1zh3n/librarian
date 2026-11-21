import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { api, ApiError } from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";

type Paths = { from: string; to: string };

export function useRenamePath(workspace: string) {
  const client = useQueryClient();
  const previous = useRef<(Paths & { operationId: string; workspace: string }) | undefined>(
    undefined,
  );
  return useMutation({
    mutationFn: ({ from, to }: Paths) => {
      const last = previous.current;
      const id =
        last?.workspace === workspace && last.from === from && last.to === to
          ? last.operationId
          : operationId();
      previous.current = { workspace, from, to, operationId: id };
      return api.renameWorkspacePath(workspace, { from, to, operationId: id });
    },
    onSuccess: async () => {
      previous.current = undefined;
      await client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        void client.invalidateQueries({ queryKey: workspaceKeys.all, exact: true });
      }
    },
  });
}
