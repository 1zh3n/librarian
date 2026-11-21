import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import { api } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Feedback } from "../../ui/Feedback";
import { AiOperationReceipt } from "./AiOperationReceipt";

export function LinkedAiOperation({
  workspace,
  id,
  username,
  writable,
}: {
  workspace: string;
  id: string;
  username: string;
  writable: boolean;
}) {
  const client = useQueryClient();
  const back = useRef<HTMLAnchorElement>(null);
  const key = [...workspaceKeys.workspace(workspace), "ai", "linked-operation", username, id];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.getAiOperation(id, signal),
    retry: false,
  });
  const operation = query.data;
  return (
    <section aria-label="指定操作">
      {query.isPending ? (
        <Feedback>正在读取操作…</Feedback>
      ) : query.isError || operation?.workspaceId !== workspace ? (
        <Feedback tone="error">无法读取此工作区操作。</Feedback>
      ) : (
        <>
          {operation.status === "canceled" && <Feedback>此操作已取消。</Feedback>}
          {operation.status === "conflict" && (
            <Feedback tone="error">文件版本已更新，请重新核对计划。</Feedback>
          )}
          {operation.answer && <p>{operation.answer}</p>}
          <AiOperationReceipt
            operation={operation}
            writable={writable}
            update={(next) => {
              client.setQueryData(key, next);
              void client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
            }}
            afterCancel={() => back.current?.focus()}
          />
        </>
      )}
      <Link
        ref={back}
        to="/workspaces/$workspaceId/ai"
        params={{ workspaceId: workspace }}
        search={{}}
      >
        返回工作区 AI
      </Link>
    </section>
  );
}
