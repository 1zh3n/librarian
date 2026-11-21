import { Feedback } from "../ui/Feedback";
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
import { Tabs, TabPanel } from "../ui/Tabs";

const route = getRouteApi("/workspaces/$workspaceId/manage");

const general = { id: "general", label: "常规" };
const members = { id: "members", label: "成员" };
const delivery = { id: "delivery", label: "外部导入" };
const release = { id: "release", label: "备份与发布" };

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
          <Feedback className={styles.status}>正在打开工作区…</Feedback>
        ) : (
          <Feedback tone="error" className={styles.status}>
            无法打开此工作区。
          </Feedback>
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
  const releaseActions = [
    ...(workspace.canWrite
      ? [
          {
            id: "release",
            label: "阅读地址",
            panel: <SnapshotPanel workspace={workspaceId} documents={documents.data ?? []} />,
          },
        ]
      : []),
    ...(workspace.canManage
      ? [
          {
            id: "release-site",
            label: "站点发布",
            panel: <PublicationPanel workspace={workspaceId} documents={documents.data ?? []} />,
          },
          {
            id: "release-backup",
            label: "Git 备份",
            panel: <BackupPanel workspace={workspaceId} />,
          },
        ]
      : []),
  ];
  const activeAction = releaseActions.find(({ id }) => id === hash) ?? releaseActions[0];
  const requested =
    hash === "space" || hash === "directory"
      ? general.id
      : releaseActions.some(({ id }) => id === hash)
        ? release.id
        : hash;
  const openTab = (key: string) => {
    void navigate({
      to: "/workspaces/$workspaceId/manage",
      params: { workspaceId },
      hash: key,
      hashScrollIntoView: false,
      resetScroll: false,
    });
  };
  const selected =
    tabs.find(({ id }) => id === requested)?.id ?? (workspace.canManage ? general.id : delivery.id);
  return (
    <div className={styles.page}>
      <h1>{workspace.name}</h1>
      <Tabs
        key={workspaceId}
        value={selected}
        onChange={openTab}
        label="空间设置"
        items={tabs}
        listClassName={styles.tabList}
        tabClassName={styles.tab}
      >
        {workspace.canManage && (
          <TabPanel id={general.id} keepMounted className={styles.group}>
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
          </TabPanel>
        )}
        {workspace.canManage && (
          <TabPanel id={members.id} keepMounted className={styles.group}>
            <WorkspaceMembers workspace={workspaceId} />
          </TabPanel>
        )}
        <TabPanel id={delivery.id} keepMounted className={styles.group}>
          <DeliveryPanel workspace={workspaceId} writable={workspace.canWrite} />
          {workspace.canManage && <DeliveryTokens workspace={workspaceId} />}
        </TabPanel>
        {activeAction && (
          <TabPanel id={release.id} keepMounted className={styles.group}>
            {releaseActions.length === 1 ? (
              activeAction.panel
            ) : (
              <Tabs
                value={activeAction.id}
                onChange={openTab}
                label="发布任务"
                items={releaseActions}
                listClassName={styles.taskList}
                tabClassName={styles.task}
              >
                {releaseActions.map(({ id, panel }) => (
                  <TabPanel key={id} id={id} keepMounted className={styles.group}>
                    {panel}
                  </TabPanel>
                ))}
              </Tabs>
            )}
          </TabPanel>
        )}
      </Tabs>
    </div>
  );
}
