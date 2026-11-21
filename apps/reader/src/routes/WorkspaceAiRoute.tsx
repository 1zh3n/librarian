import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";
import type { AiTranscriptVisit } from "../features/document/sourceVisit";
import { documentsQuery, sessionQuery, workspacesQuery } from "../api/queries";
import { LinkedAiOperation } from "../features/ai/LinkedAiOperation";
import { AiPanel } from "../features/ai/AiPanel";
import styles from "../features/ai/AiPanel.module.css";

const route = getRouteApi("/workspaces/$workspaceId/ai");

// History entries are kept in memory for Back navigation and discarded on reload.
const visits = new Map<string, AiTranscriptVisit>();

export function WorkspaceAiRoute() {
  const { workspaceId } = route.useParams();
  const { operationId } = route.useSearch();
  return <ChatPage workspaceId={workspaceId} operationId={operationId} />;
}

export function AssistantRoute() {
  return <ChatPage />;
}

function ChatPage({
  workspaceId,
  operationId,
}: {
  workspaceId?: string;
  operationId?: string | undefined;
}) {
  const { data: session } = useQuery(sessionQuery);
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  const visitKey = session && entry && JSON.stringify([session.username, workspaceId, entry]);
  const visit = useMemo(() => (visitKey ? visits.get(visitKey) : undefined), [visitKey]);
  const { data: workspaces } = useQuery(workspacesQuery);
  const { data: documents } = useQuery({
    ...documentsQuery(workspaceId ?? ""),
    enabled: Boolean(workspaceId),
  });
  // A signed-in member can create their first workspace from the global assistant.
  const writable = workspaceId
    ? Boolean(workspaces?.some((item) => item.id === workspaceId && item.canWrite))
    : Boolean(session);
  return (
    <div className={styles.workspace}>
      <h1>
        {workspaceId
          ? `${workspaces?.find((item) => item.id === workspaceId)?.name ?? ""} · 工作区 AI`
          : "AI 助手"}
      </h1>
      {operationId && workspaceId ? (
        session && (
          <LinkedAiOperation
            key={operationId}
            workspace={workspaceId}
            id={operationId}
            username={session.username}
            writable={writable}
          />
        )
      ) : (
        <AiPanel
          key={workspaceId}
          workspace={workspaceId ?? ""}
          standalone
          global={!workspaceId}
          writable={writable}
          returnVisit={visit}
          onSourceVisit={(next) => {
            if (!visitKey) return;
            visits.set(visitKey, next);
            const oldest = visits.keys().next();
            if (visits.size > 50 && !oldest.done) visits.delete(oldest.value);
          }}
          documents={documents ?? []}
        />
      )}
    </div>
  );
}
