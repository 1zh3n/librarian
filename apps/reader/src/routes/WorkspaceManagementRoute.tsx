import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { documentsQuery, workspacesQuery } from "../api/queries";
import { DeliveryPanel } from "../features/delivery/DeliveryPanel";
import { DeliveryTokens } from "../features/delivery/DeliveryTokens";
import { BackupPanel } from "../features/release/BackupPanel";
import { PublicationPanel } from "../features/release/PublicationPanel";
import { SnapshotPanel } from "../features/snapshot/SnapshotPanel";
import { RenamePathForm } from "../features/workspace/RenamePathForm";
import { WorkspaceEditor } from "../features/workspace/WorkspaceEditor";
import { WorkspaceMembers } from "../features/workspace/WorkspaceMembers";
import styles from "../features/workspace/Management.module.css";

const route = getRouteApi("/workspaces/$workspaceId/manage");

const space = { id: "space", title: "空间与成员" };
const directory = { id: "directory", title: "目录" };
const delivery = { id: "delivery", title: "投递" };
const release = { id: "release", title: "备份、发布与分享" };
const sharing = { id: "release", title: "分享" };

function ManagementGroup({
  group,
  children,
}: {
  group: { id: string; title: string };
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={group.id} className={styles.group}>
      <h2 className={styles.groupTitle} id={group.id} tabIndex={-1}>
        {group.title}
      </h2>
      {children}
    </section>
  );
}

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
  if (!workspace) {
    return (
      <div className={styles.page}>
        {list.isPending ? (
          <output className={styles.status}>正在打开工作区…</output>
        ) : (
          <p role="alert" className={styles.status}>
            无法打开此工作区。
          </p>
        )}
      </div>
    );
  }
  const releaseGroup = workspace.canManage ? release : sharing;
  const groups = [
    ...(workspace.canManage ? [space, directory] : []),
    delivery,
    ...(workspace.canManage || workspace.canWrite ? [releaseGroup] : []),
  ];
  return (
    <div className={styles.page}>
      <h1>{workspace.name}</h1>
      {groups.length > 1 && (
        <nav aria-label="工作区管理" className={styles.navigation}>
          {groups.map(({ id, title }) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
        </nav>
      )}
      {workspace.canManage && (
        <>
          <ManagementGroup group={space}>
            <section className={styles.section} aria-label="空间设置">
              <h3>空间设置</h3>
              <WorkspaceEditor key={workspaceId} current={workspace} />
            </section>
            <WorkspaceMembers key={workspaceId} workspace={workspaceId} />
          </ManagementGroup>
          <ManagementGroup group={directory}>
            <section className={styles.section} aria-label="重命名路径">
              <h3>重命名路径</h3>
              <RenamePathForm key={workspaceId} workspace={workspaceId} />
            </section>
          </ManagementGroup>
        </>
      )}
      <ManagementGroup group={delivery}>
        <DeliveryPanel
          key={`delivery-${workspaceId}`}
          workspace={workspaceId}
          writable={workspace.canWrite}
        />
        {workspace.canManage && (
          <DeliveryTokens key={`token-${workspaceId}`} workspace={workspaceId} />
        )}
      </ManagementGroup>
      {(workspace.canManage || workspace.canWrite) && (
        <ManagementGroup group={releaseGroup}>
          {workspace.canManage && (
            <>
              <BackupPanel key={`backup-${workspaceId}`} workspace={workspaceId} />
              <PublicationPanel
                key={`publication-${workspaceId}`}
                workspace={workspaceId}
                documents={documents.data ?? []}
              />
            </>
          )}
          {workspace.canWrite && (
            <SnapshotPanel
              key={`snapshot-${workspaceId}`}
              workspace={workspaceId}
              documents={documents.data ?? []}
            />
          )}
        </ManagementGroup>
      )}
    </div>
  );
}
