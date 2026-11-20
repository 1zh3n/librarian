import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { documentsQuery, workspacesQuery } from "../api/queries";
import { DeliveryPanel } from "../features/delivery/DeliveryPanel";
import { DeliveryTokens } from "../features/delivery/DeliveryTokens";
import { SnapshotPanel } from "../features/snapshot/SnapshotPanel";
import { RenamePathForm } from "../features/workspace/RenamePathForm";
import { WorkspaceEditor } from "../features/workspace/WorkspaceEditor";
import styles from "../features/workspace/Management.module.css";

const route = getRouteApi("/workspaces/$workspaceId/manage");

export function CreateWorkspaceRoute() {
  const navigate = useNavigate();
  return (
    <div className={styles.page}>
      <h1>新建空间</h1>
      <WorkspaceEditor
        onCreated={(workspace) => {
          void navigate({
            to: "/workspaces/$workspaceId/manage",
            params: { workspaceId: workspace.id },
            replace: true,
          });
        }}
      />
    </div>
  );
}

export function WorkspaceManagementRoute() {
  const { workspaceId } = route.useParams();
  const list = useQuery(workspacesQuery);
  const documents = useQuery(documentsQuery(workspaceId));
  const workspace = list.data?.find((item) => item.id === workspaceId);
  if (!workspace) return null;
  return (
    <div className={styles.page}>
      <h1>{workspace.name}</h1>
      {workspace.canManage && (
        <>
          <section className={styles.section} aria-label="空间设置">
            <h2>空间设置</h2>
            <WorkspaceEditor key={workspaceId} current={workspace} />
          </section>
          <section className={styles.section} aria-label="重命名路径">
            <h2>重命名路径</h2>
            <RenamePathForm key={workspaceId} workspace={workspaceId} />
          </section>
        </>
      )}
      <DeliveryPanel
        key={`delivery-${workspaceId}`}
        workspace={workspaceId}
        writable={workspace.canWrite}
      />
      {workspace.canManage && (
        <DeliveryTokens key={`token-${workspaceId}`} workspace={workspaceId} />
      )}
      {workspace.canWrite && (
        <SnapshotPanel
          key={`snapshot-${workspaceId}`}
          workspace={workspaceId}
          documents={documents.data ?? []}
        />
      )}
    </div>
  );
}
