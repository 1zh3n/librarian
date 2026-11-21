import { Icon } from "../ui/Icon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { ActionMenu } from "../ui/Menu";
import { Tooltip } from "../ui/Tooltip";
import { ReaderDock } from "../ui/ReaderDock/ReaderDock";
import { api, ApiError } from "../api/client";
import type { DevicePreferences, DocumentSnapshot, DocumentSummary } from "../api/client";
import { documentsQuery, sessionQuery, workspaceKeys, workspacesQuery } from "../api/queries";
import { RenameDocumentDialog } from "../features/document/RenameDocumentDialog";
import { CreateDocumentDialog } from "../features/document/CreateDocumentDialog";
import { rememberRecentDocument } from "../features/navigation/recentDocuments";
import {
  handleWorkspaceMenu,
  WorkspaceContextMenu,
} from "../features/navigation/WorkspaceContextMenu";
import type {
  OpenWorkspaceMenu,
  WorkspaceMenuTarget,
} from "../features/navigation/WorkspaceContextMenu";
import { DirectoryTree } from "../ui/DirectoryTree/DirectoryTree";
import { purgeOfflineReader } from "../features/offline/readerOffline";
import {
  isEditingTarget,
  ReaderLayoutContext,
  useReadingFocus,
} from "../features/reading/readingFocus";
import { useDevicePreferences } from "../features/settings/devicePreferences";
import styles from "./WorkspaceShell.module.css";

declare module "@tanstack/history" {
  interface HistoryState {
    workspaceCreationSource?: string;
  }
}

const noDocuments: readonly DocumentSummary[] = [];
const CommandPalette = lazy(() =>
  import("../features/navigation/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const ReadingSettings = lazy(() =>
  import("../features/settings/ReadingSettings").then((module) => ({
    default: module.ReadingSettings,
  })),
);
const presets = [
  ["reading", "阅读布局", false],
  ["writing", "写作布局", true],
  ["research", "研究布局", true],
  ["review", "校订布局", false],
] as const;

export function WorkspaceShell() {
  const { workspaceId, documentId } = useParams({ strict: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toolRoute = useRouterState({
    select: ({ matches }) =>
      matches.find(
        ({ routeId }) =>
          routeId === "/workspaces/new" ||
          routeId === "/workspaces/$workspaceId/manage" ||
          routeId === "/workspaces/$workspaceId/ai" ||
          routeId === "/accounts",
      )?.routeId,
  });
  const creating = toolRoute === "/workspaces/new";
  const creationSource = useRouterState({
    select: ({ location }) => location.state.workspaceCreationSource,
  });
  const accountSettings = toolRoute === "/accounts";
  const workspaces = useQuery(workspacesQuery);
  const authenticated = workspaces.isSuccess;
  const session = useQuery({ ...sessionQuery, enabled: authenticated });
  const contextWorkspaceId = creating ? creationSource : (workspaceId ?? workspaces.data?.[0]?.id);
  const workspace = workspaces.data?.find((item) => item.id === contextWorkspaceId);
  const selected = workspace?.id ?? "";
  const resource = useQuery({ ...documentsQuery(selected), enabled: Boolean(workspace) });
  const documents = resource.data ?? noDocuments;
  const active = documents.find((item) => item.id === documentId);
  const username = session.data?.username;
  const activeFolder = active?.path.split("/").slice(0, -1).join("/") ?? "";
  const firstDocument = documents[0]?.id;
  const viewport = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const { preferences, settingsQuery, save } = useDevicePreferences(Boolean(workspaces.data));
  const focus = useReadingFocus(viewport, layout, documentId);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 801px)").matches);
  const [navigationOverride, setNavigationOverride] = useState<boolean>();
  const [layoutSelection, setLayoutSelection] = useState(0);
  const [search, setSearch] = useState(false);
  const [contextMenu, setContextMenu] = useState<WorkspaceMenuTarget>();
  const openContextMenu = useCallback<OpenWorkspaceMenu>((trigger, folder, point) => {
    trigger.focus({ preventScroll: true });
    setContextMenu({ trigger, folder, point });
  }, []);
  const [renaming, setRenaming] = useState<{ document: DocumentSummary; origin: HTMLElement }>();
  const canRename = Boolean(
    workspace?.canWrite && workspace.canManage && workspace.revisionMode === "managed",
  );
  const menuDocumentId =
    contextMenu?.trigger.closest<HTMLElement>("[data-context-document]")?.dataset.contextDocument;
  const menuDocument = menuDocumentId
    ? documents.find((doc) => doc.id === menuDocumentId)
    : undefined;
  function renameDocument(document: DocumentSummary, origin: HTMLElement) {
    if (canRename && document.workspaceId === selected) setRenaming({ document, origin });
  }
  function closeRename() {
    setRenaming(undefined);
    if (!renaming) return;
    const { origin, document } = renaming;
    requestAnimationFrame(() => {
      const trigger = origin.isConnected
        ? origin
        : layout.current?.querySelector<HTMLElement>(
            `[data-context-document="${CSS.escape(document.id)}"]`,
          );
      trigger?.focus({ preventScroll: true });
    });
  }
  const [settings, setSettings] = useState(false);
  const dialogOrigin = useRef<Element | null>(null);
  const [settingsError, setSettingsError] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [createDocumentFor, setCreateDocumentFor] = useState<{
    workspace: string;
    folder: string;
    origin: Element;
  }>();
  const [createdDocument, setCreatedDocument] = useState<string>();
  const [creationNotice, setCreationNotice] = useState<string>();
  const pendingCreation = useRef<DocumentSummary>(undefined);
  const router = useRouter();
  const clearCreatedDocument = useCallback(() => setCreatedDocument(undefined), []);
  const listCreatedDocument = useCallback(
    (created: DocumentSummary) => {
      queryClient.setQueryData<DocumentSummary[]>(
        workspaceKeys.documents(created.workspaceId),
        (previous) => [
          ...(previous ?? []).filter((document) => document.id !== created.id),
          created,
        ],
      );
    },
    [queryClient],
  );
  const navigationCancelled = useCallback(
    (pathname: string) => {
      const created = pendingCreation.current;
      if (!created || pathname !== `/workspaces/${created.workspaceId}/documents/${created.id}`)
        return;
      pendingCreation.current = undefined;
      clearCreatedDocument();
      listCreatedDocument(created);
      setCreationNotice(`已新建「${created.title}」。可在目录中打开。`);
    },
    [clearCreatedDocument, listCreatedDocument],
  );
  const navigation = navigationOverride ?? preferences.navigation ?? wide;
  const navigationVisible = Boolean(workspace && navigation && !focus.active);
  const canCreate = Boolean(workspace?.canWrite);

  const showCreateDocument = useCallback(
    (folder: string, origin: Element) => {
      if (canCreate) {
        setCreationNotice(undefined);
        setCreateDocumentFor({ workspace: selected, folder, origin });
      }
    },
    [canCreate, selected],
  );

  async function openCreatedDocument(snapshot: DocumentSnapshot) {
    const { id } = snapshot.document;
    queryClient.setQueryData(workspaceKeys.document(selected, id), snapshot);
    pendingCreation.current = snapshot.document;
    setCreatedDocument(id);
    setCreateDocumentFor(undefined);
    await navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: id },
    });
    if (pendingCreation.current !== snapshot.document) return;
    pendingCreation.current = undefined;
    if (!wide) setNavigationOverride(false);
    listCreatedDocument(snapshot.document);
  }

  useEffect(() => {
    const query = window.matchMedia("(min-width: 801px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    if (!selected || documentId || toolRoute || !firstDocument || createDocumentFor) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: firstDocument },
      replace: true,
    });
  }, [selected, documentId, firstDocument, navigate, toolRoute, createDocumentFor]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: 0, left: 0 });
  }, [documentId, toolRoute]);
  useEffect(
    () =>
      router.subscribe("onResolved", ({ pathChanged, toLocation }) => {
        if (pathChanged) {
          if (!wide && toLocation.pathname === "/workspaces/new") setNavigationOverride(false);
          setContextMenu(undefined);
          setCreationNotice(undefined);
        }
      }),
    [router, wide],
  );

  useEffect(() => {
    if (active && username && selected) rememberRecentDocument(username, selected, active.id);
  }, [active, selected, username]);

  useEffect(() => {
    if (!authenticated) return;
    function shortcut(event: KeyboardEvent) {
      if (
        !event.isComposing &&
        !isEditingTarget(event.target) &&
        !(event.target instanceof Element && event.target.closest("[role=dialog]")) &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        dialogOrigin.current = document.activeElement;
        setSearch(true);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [authenticated]);

  async function saveLayout(patch: Partial<DevicePreferences>) {
    setSettingsError(false);
    try {
      await save(patch);
      return true;
    } catch {
      setSettingsError(true);
      return false;
    }
  }

  async function selectLayout(preset: (typeof presets)[number]) {
    const [layout, , navigation] = preset;
    if (!(await saveLayout({ layout, navigation }))) return;
    if (focus.active) focus.toggle();
    setNavigationOverride(undefined);
    setLayoutSelection((selection) => selection + 1);
  }

  const openDocument = useCallback(
    (id: string, destination = selected) => {
      if (!destination) return;
      const target = {
        to: "/workspaces/$workspaceId/documents/$documentId" as const,
        params: { workspaceId: destination, documentId: id },
      };
      if (router.state.location.pathname === router.buildLocation(target).pathname) return;
      void navigate(target);
      if (!wide) setNavigationOverride(false);
    },
    [navigate, router, selected, wide],
  );

  const workspacesUnavailable = !workspaces.data && workspaces.isError;
  const unauthorized =
    workspacesUnavailable &&
    workspaces.error instanceof ApiError &&
    workspaces.error.status === 401;
  const login = `/.auth/librarian/login?${new URLSearchParams({ next: window.location.pathname })}`;
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError(false);
    try {
      await api.logout();
      await purgeOfflineReader();
      window.location.replace("/.auth/librarian/login");
    } catch {
      setLogoutError(true);
      setSigningOut(false);
    }
  }

  const focusLabel = focus.active ? "退出专注阅读" : "专注阅读";
  const commands = [
    ...(documentId ? [{ id: "focus", title: focusLabel, run: focus.toggle }] : []),
    { id: "settings", title: "设置", run: () => setSettings(true) },
    ...(session.data
      ? [
          {
            id: "account-settings",
            title: session.data.isAdmin ? "账号管理" : "修改密码",
            run: () => void navigate({ to: "/accounts" }),
          },
        ]
      : []),
    { id: "logout", title: "退出登录", run: () => void logout() },
    ...(selected
      ? [
          {
            id: "workspace-ai",
            title: "Workspace AI",
            run: () =>
              void navigate({
                to: "/workspaces/$workspaceId/ai",
                params: { workspaceId: selected },
              }),
          },
        ]
      : []),
  ];

  return (
    <ReaderLayoutContext
      value={{
        focus,
        preferences,
        layoutSelection,
        savePreferences: save,
        createdDocument,
        renameDocument: canRename ? renameDocument : undefined,
        clearCreatedDocument,
        navigationCancelled,
      }}
    >
      <div
        className={styles.application}
        data-reading-focus={focus.active || undefined}
        tabIndex={-1}
        onContextMenu={
          authenticated ? (event) => handleWorkspaceMenu(event, openContextMenu) : undefined
        }
        onKeyDownCapture={
          authenticated ? (event) => handleWorkspaceMenu(event, openContextMenu) : undefined
        }
      >
        <header className={styles.bar}>
          {workspace ? (
            <Button
              ref={navigationToggle}
              aria-label={navigation ? "收起目录" : "展开目录"}
              aria-controls="workspace-navigation"
              className={styles.button}
              aria-pressed={navigationVisible}
              isDisabled={focus.active}
              onPress={() => {
                const next = !navigation;
                setNavigationOverride(next);
                void saveLayout({ navigation: next });
              }}
            >
              目录
            </Button>
          ) : (
            <Link to="/" className={styles.brand}>
              Librarian
            </Link>
          )}
          <div className={styles.breadcrumb} title={active?.path}>
            {activeFolder && <span className={styles.breadcrumbFolder}>{activeFolder} / </span>}
            <span className={styles.breadcrumbTitle}>
              {active?.path.split("/").at(-1) ?? workspace?.name}
            </span>
          </div>
          {authenticated && (
            <div className={styles.topActions}>
              {workspace && (
                <ActionMenu
                  label="布局"
                  trigger={<Button className={styles.button}>布局</Button>}
                  popoverClassName={styles.popover}
                  className={styles.layoutMenu}
                  choiceGroup={{
                    label: "布局预设",
                    className: styles.presets,
                    selectedId: preferences.layout === "custom" ? undefined : preferences.layout,
                    items: presets.map((preset) => {
                      const [id, label, navigation] = preset;
                      return {
                        id,
                        label,
                        className: styles.layoutOption,
                        run: () => void selectLayout(preset),
                        content: (
                          <>
                            <span aria-hidden="true" className={styles.preview} data-preset={id}>
                              {navigation && <span className={styles.previewNavigation} />}
                              <span className={styles.previewBody}>
                                <Icon name="align-left" />
                              </span>
                              {id !== "reading" && <span className={styles.previewTools} />}
                            </span>
                            {label}
                          </>
                        ),
                      };
                    }),
                  }}
                  items={
                    documentId
                      ? [
                          {
                            id: "focus",
                            label: focusLabel,
                            className: styles.spaceOption,
                            run: focus.toggle,
                          },
                        ]
                      : []
                  }
                />
              )}
              <Button
                aria-label={workspace ? "搜索文档" : "命令"}
                aria-keyshortcuts="Control+K Meta+K"
                className={styles.button}
                aria-haspopup="dialog"
                onPress={(event) => {
                  dialogOrigin.current = event.target;
                  setSearch(true);
                }}
              >
                {workspace ? "搜索" : "命令"}
              </Button>
              <Button
                className={styles.button}
                aria-haspopup="dialog"
                onPress={(event) => {
                  dialogOrigin.current = event.target;
                  setSettings(true);
                }}
              >
                设置
              </Button>
            </div>
          )}
        </header>
        <ReaderDock
          layoutRef={layout}
          wide={wide}
          navigationVisible={navigationVisible}
          sidebarWidth={preferences.sidebarWidth}
          onWidthChange={(sidebarWidth) => void saveLayout({ sidebarWidth })}
          onCollapse={() => {
            setNavigationOverride(false);
            void saveLayout({ navigation: false });
            navigationToggle.current?.focus({ preventScroll: true });
          }}
          navigation={
            workspace && (
              <aside
                id="workspace-navigation"
                tabIndex={-1}
                className={styles.navigation}
                hidden={!navigationVisible}
              >
                <div className={styles.workspaceBar}>
                  <ActionMenu
                    label="空间"
                    className={styles.spaces}
                    popoverClassName={styles.popover}
                    trigger={
                      <Button
                        aria-label={`切换空间，当前为${workspace.name}`}
                        className={styles.workspace}
                      >
                        <span className={styles.workspaceName}>{workspace.name}</span>
                        <Icon name="chevron-down" className={styles.workspaceArrow} />
                      </Button>
                    }
                    choiceGroup={{
                      label: "已有空间",
                      selectedId: workspace.id,
                      className: styles.presets,
                      items: (workspaces.data ?? []).map((item) => ({
                        id: item.id,
                        label: item.name,
                        className: styles.spaceOption,
                        run: () => {
                          if (item.id !== selected || creating)
                            void navigate({
                              to: "/workspaces/$workspaceId",
                              params: { workspaceId: item.id },
                            });
                        },
                      })),
                    }}
                    items={[
                      {
                        id: "new-workspace",
                        label: "新建空间",
                        className: styles.spaceOption,
                        disabled: creating,
                        run: () =>
                          void navigate({
                            to: "/workspaces/new",
                            state: { workspaceCreationSource: selected },
                          }),
                      },
                    ]}
                  />
                  <Tooltip text="空间设置" className={styles.tooltip}>
                    <Button
                      aria-label="空间设置"
                      className={styles.workspaceSettings}
                      onPress={() => {
                        if (!wide) setNavigationOverride(false);
                        void navigate({
                          to: "/workspaces/$workspaceId/manage",
                          params: { workspaceId: workspace.id },
                        });
                      }}
                    >
                      <Icon name="settings" />
                    </Button>
                  </Tooltip>
                </div>
                {resource.data && (
                  <DirectoryTree
                    key={selected}
                    documents={documents}
                    activeDocument={documentId}
                    open={openDocument}
                    openMenu={canCreate ? openContextMenu : undefined}
                  />
                )}
              </aside>
            )
          }
        >
          <main
            ref={viewport}
            tabIndex={-1}
            className={styles.viewport}
            style={{ paddingBlockStart: wide ? 0 : focus.navigationInset }}
          >
            {unauthorized ? (
              <div className={styles.state}>
                <h1>登录 Librarian</h1>
                <a className={styles.signIn} href={login}>
                  登录
                </a>
              </div>
            ) : workspacesUnavailable ? (
              <p role="alert" className={styles.state}>
                无法加载空间
              </p>
            ) : workspaces.isPending ? (
              <output className={styles.state}>正在加载空间…</output>
            ) : creating || accountSettings ? (
              <Outlet />
            ) : !workspace ? (
              <div className={styles.state}>
                <p>{workspaceId ? "此空间不可用" : "没有可访问的空间"}</p>
                {!workspaceId && (
                  <>
                    <Link to="/workspaces/new" className={styles.signIn}>
                      新建空间
                    </Link>
                    <Button
                      className={styles.button}
                      isDisabled={signingOut}
                      onPress={() => void logout()}
                    >
                      退出登录
                    </Button>
                  </>
                )}
              </div>
            ) : documentId || toolRoute ? (
              <Outlet />
            ) : resource.isError ? (
              <p role="alert" className={styles.state}>
                无法加载目录
              </p>
            ) : resource.isPending || firstDocument ? (
              <output className={styles.state}>正在打开空间…</output>
            ) : (
              <div className={styles.state}>
                <p>这个空间还没有文档</p>
                {canCreate && (
                  <Button
                    variant="primary"
                    onPress={(event) => showCreateDocument("", event.target)}
                  >
                    新建第一篇文档
                  </Button>
                )}
              </div>
            )}
          </main>
        </ReaderDock>
        {authenticated && contextMenu && (
          <WorkspaceContextMenu
            target={contextMenu}
            hasWorkspace={Boolean(workspace)}
            rename={
              canRename && menuDocument
                ? () => renameDocument(menuDocument, contextMenu.trigger)
                : undefined
            }
            create={
              canCreate &&
              ((!creating && !accountSettings) ||
                contextMenu.trigger.closest("#workspace-navigation"))
                ? showCreateDocument
                : undefined
            }
            search={(origin) => {
              dialogOrigin.current = origin;
              setSearch(true);
            }}
            close={() => setContextMenu(undefined)}
          />
        )}
        {renaming?.document.workspaceId === selected && (
          <RenameDocumentDialog
            document={renaming.document}
            allowed={canRename}
            close={closeRename}
          />
        )}
        {createDocumentFor?.workspace === selected && (
          <CreateDocumentDialog
            workspace={selected}
            folder={createDocumentFor.folder}
            canCreate={canCreate}
            created={openCreatedDocument}
            close={() => {
              const { origin } = createDocumentFor;
              setCreateDocumentFor(undefined);
              requestAnimationFrame(() => {
                if (document.activeElement === document.body && origin instanceof HTMLElement) {
                  origin.focus({ preventScroll: true });
                }
              });
            }}
          />
        )}
        {settingsError && (
          <p role="alert" className={styles.notice}>
            布局未保存，请重试。
          </p>
        )}
        {creationNotice && <output className={styles.notice}>{creationNotice}</output>}
        {logoutError && (
          <p role="alert" className={styles.notice}>
            无法完成退出登录，请重试。
          </p>
        )}
        {focus.announce && <output className={styles.notice}>专注阅读 · Esc 退出</output>}
        {search && authenticated && (
          <Suspense>
            <CommandPalette
              workspace={selected}
              workspaces={workspaces.data ?? []}
              username={username ?? ""}
              documents={documents}
              commands={commands}
              onClose={() => setSearch(false)}
              openDocument={openDocument}
            />
          </Suspense>
        )}
        {settings && (
          <Suspense>
            <ReadingSettings
              preferences={settingsQuery.data}
              loading={settingsQuery.isFetching}
              retry={() => void settingsQuery.refetch()}
              save={save}
              close={() => {
                setSettings(false);
                const origin = dialogOrigin.current;
                if (origin instanceof HTMLElement) {
                  requestAnimationFrame(() => origin.focus({ preventScroll: true }));
                }
              }}
            />
          </Suspense>
        )}
      </div>
    </ReaderLayoutContext>
  );
}
