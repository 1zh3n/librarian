import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { documentsQuery, workspacesQuery } from "../api/queries";
import { AiPanel } from "../features/ai/AiPanel";
import styles from "../features/ai/AiPanel.module.css";

const route = getRouteApi("/workspaces/$workspaceId/ai");

export function WorkspaceAiRoute() {
  const { workspaceId } = route.useParams();
  const { data: workspaces } = useQuery(workspacesQuery);
  const { data: documents } = useQuery(documentsQuery(workspaceId));
  const writable = workspaces?.some((item) => item.id === workspaceId && item.canWrite) ?? false;
  return (
    <div className={styles.workspace}>
      <h1>Workspace AI</h1>
      <AiPanel
        key={workspaceId}
        workspace={workspaceId}
        writable={writable}
        documents={documents ?? []}
      />
    </div>
  );
}
