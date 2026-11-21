import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
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
import { Tabs } from "../ui/Tabs";

const route = getRouteApi("/workspaces/$workspaceId/manage");

const general = { id: "general", title: "常规" };
const members = { id: "members", title: "成员" };
const delivery = { id: "delivery", title: "外部导入" };
const release = { id: "release", title: "备份与发布" };

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
  const navigate = useNavigate();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const list = useQuery(workspacesQuery);
  const documents = useQuery(documentsQuery(workspaceId));
  const workspace = list.data?.find((item) => item.id === workspaceId);
  const renameHeading = useRef<HTMLHeadingElement>(null);
  const canManage = workspace?.canManage ?? false;

  useEffect(() => {
    if (!canManage || hash !== "directory") return;
    const frame = requestAnimationFrame(() => {
      renameHeading.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [canManage, hash, workspaceId]);

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
  const canRelease = workspace.canManage || workspace.canWrite;
  const tabs = [
    ...(workspace.canManage ? [general, members] : []),
    delivery,
    ...(canRelease ? [release] : []),
  ];
  const requested = hash === "space" || hash === "directory" ? general.id : hash;
  const selected =
    tabs.find(({ id }) => id === requested)?.id ?? (workspace.canManage ? general.id : delivery.id);
  return (
    <div className={styles.page}>
      <h1>{workspace.name}</h1>
      <Tabs
        key={workspaceId}
        selectedKey={selected}
        onSelectionChange={(key) =>
          void navigate({
            to: "/workspaces/$workspaceId/manage",
            params: { workspaceId },
            hash: String(key),
            hashScrollIntoView: false,
            resetScroll: false,
          })
        }
      >
        <Tabs.List aria-label="空间设置" className={styles.tabList}>
          {tabs.map(({ id, title }) => (
            <Tabs.Tab key={id} id={id} className={styles.tab}>
              {title}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {workspace.canManage && (
          <Tabs.Panel id={general.id} shouldForceMount className={styles.group}>
            <section className={styles.section} aria-label="空间设置">
              <h2 id="space">空间设置</h2>
              <WorkspaceEditor current={workspace} />
            </section>
            <section className={styles.section} aria-label="移动或重命名">
              <h2 id="directory" ref={renameHeading}>
                移动或重命名
              </h2>
              <RenamePathForm workspace={workspaceId} />
            </section>
          </Tabs.Panel>
        )}
        {workspace.canManage && (
          <Tabs.Panel id={members.id} shouldForceMount className={styles.group}>
            <WorkspaceMembers workspace={workspaceId} />
          </Tabs.Panel>
        )}
        <Tabs.Panel id={delivery.id} shouldForceMount className={styles.group}>
          <DeliveryPanel workspace={workspaceId} writable={workspace.canWrite} />
          {workspace.canManage && <DeliveryTokens workspace={workspaceId} />}
        </Tabs.Panel>
        {canRelease && (
          <Tabs.Panel id={release.id} shouldForceMount className={styles.group}>
            {workspace.canManage && (
              <>
                <BackupPanel workspace={workspaceId} />
                <PublicationPanel workspace={workspaceId} documents={documents.data ?? []} />
              </>
            )}
            {workspace.canWrite && (
              <SnapshotPanel workspace={workspaceId} documents={documents.data ?? []} />
            )}
          </Tabs.Panel>
        )}
      </Tabs>
    </div>
  );
}
