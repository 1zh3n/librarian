import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
  Tooltip,
  TooltipTrigger,
} from "../ui/primitives";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { api, ApiError } from "../api/client";
import type { DevicePreferences, DocumentSnapshot, DocumentSummary } from "../api/client";
import { documentsQuery, sessionQuery, workspaceKeys, workspacesQuery } from "../api/queries";
import { CreateDocumentDialog } from "../features/document/CreateDocumentDialog";
import { rememberRecentDocument } from "../features/navigation/recentDocuments";
import { SpaceTree } from "../features/navigation/SpaceTree";
import { purgeOfflineReader } from "../features/offline/readerOffline";
import {
  isEditingTarget,
  ReaderLayoutContext,
  useReadingFocus,
} from "../features/reading/readingFocus";
import { useDevicePreferences } from "../features/settings/devicePreferences";
import styles from "./WorkspaceShell.module.css";

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
  const accountSettings = toolRoute === "/accounts";
  const workspaces = useQuery(workspacesQuery);
  const authenticated = workspaces.isSuccess;
  const session = useQuery({ ...sessionQuery, enabled: authenticated });
  const workspace = workspaceId
    ? workspaces.data?.find((item) => item.id === workspaceId)
    : workspaces.data?.[0];
  const selected = workspace?.id ?? "";
  const resource = useQuery({ ...documentsQuery(selected), enabled: Boolean(workspace) });
  const documents = resource.data ?? noDocuments;
  const active = documents.find((item) => item.id === documentId);
  const username = session.data?.username;
  const activeFolder = active?.path.split("/").slice(0, -1).join("/") ?? "";
  const firstDocument = documents[0]?.id;
  const viewport = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const navigationPanel = usePanelRef();
  const { preferences, save } = useDevicePreferences(Boolean(workspaces.data));
  const focus = useReadingFocus(viewport, layout, documentId);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 801px)").matches);
  const [navigationOverride, setNavigationOverride] = useState<boolean>();
  const [layoutSelection, setLayoutSelection] = useState(0);
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [logoutError, setLogoutError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [createDocumentFor, setCreateDocumentFor] = useState<string>();
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

  function showCreateDocument() {
    if (canCreate) {
      setCreationNotice(undefined);
      setCreateDocumentFor(selected);
    }
  }

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

  useLayoutEffect(() => {
    const panel = navigationPanel.current;
    if (!panel) return;
    if (!navigationVisible) panel.collapse();
    else {
      panel.expand();
      panel.resize(wide ? preferences.sidebarWidth : 190);
    }
  }, [navigationPanel, navigationVisible, preferences.sidebarWidth, wide]);

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
      router.subscribe("onResolved", ({ pathChanged }) => {
        if (pathChanged) setCreationNotice(undefined);
      }),
    [router],
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
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
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

  function openDocument(id: string, destination = selected) {
    if (!destination || id === documentId) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: destination, documentId: id },
    });
    if (!wide) setNavigationOverride(false);
  }

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
    { id: "settings", title: "阅读设置", run: () => setSettings(true) },
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
        clearCreatedDocument,
        navigationCancelled,
      }}
    >
      <div className={styles.application} data-reading-focus={focus.active || undefined}>
        <header className={styles.bar}>
          {workspace ? (
            <ToggleButton
              aria-label={navigation ? "收起目录" : "展开目录"}
              aria-controls="workspace-navigation"
              className={styles.button}
              isSelected={navigationVisible}
              isDisabled={focus.active}
              onChange={(next) => {
                setNavigationOverride(next);
                void saveLayout({ navigation: next });
              }}
            >
              目录
            </ToggleButton>
          ) : (
            <Link to="/" className={styles.brand}>
              Librarian
            </Link>
          )}
          <div className={styles.breadcrumb} title={active?.path}>
            {activeFolder && <span className={styles.breadcrumbFolder}>{activeFolder} / </span>}
            <span className={styles.breadcrumbTitle}>{active?.title ?? workspace?.name}</span>
          </div>
          {authenticated && (
            <div className={styles.topActions}>
              {workspace && (
                <MenuTrigger>
                  <Button className={styles.button}>布局</Button>
                  <Popover className={styles.popover}>
                    <Menu className={styles.layoutMenu}>
                      <MenuSection
                        aria-label="布局预设"
                        className={styles.presets}
                        selectionMode="single"
                        selectedKeys={preferences.layout === "custom" ? [] : [preferences.layout]}
                        shouldCloseOnSelect
                      >
                        {presets.map((preset) => {
                          const [id, label, navigation] = preset;
                          return (
                            <MenuItem
                              key={id}
                              id={id}
                              textValue={label}
                              className={styles.layoutOption}
                              onAction={() => void selectLayout(preset)}
                            >
                              <span aria-hidden="true" className={styles.preview} data-preset={id}>
                                {navigation && <span className={styles.previewNavigation} />}
                                <span className={styles.previewBody} />
                                {id !== "reading" && <span className={styles.previewTools} />}
                              </span>
                              {label}
                            </MenuItem>
                          );
                        })}
                      </MenuSection>
                      {documentId && (
                        <MenuItem id="focus" className={styles.spaceOption} onAction={focus.toggle}>
                          {focusLabel}
                        </MenuItem>
                      )}
                      <MenuItem
                        id="settings"
                        className={styles.spaceOption}
                        onAction={() => setSettings(true)}
                      >
                        阅读设置
                      </MenuItem>
                    </Menu>
                  </Popover>
                </MenuTrigger>
              )}
              <Button
                aria-label={workspace ? "搜索文档" : "命令"}
                aria-keyshortcuts="Control+K Meta+K"
                className={styles.button}
                onPress={() => setSearch(true)}
              >
                {workspace ? "搜索" : "命令"}
              </Button>
            </div>
          )}
        </header>
        <Group
          className={styles.columns}
          elementRef={layout}
          orientation={wide ? "horizontal" : "vertical"}
          resizeTargetMinimumSize={{ coarse: 44, fine: 14 }}
          onLayoutChanged={(_layout, meta) => {
            if (!meta.isUserInteraction || !wide || !navigationVisible) return;
            const panel = navigationPanel.current;
            if (!panel) return;
            const width = Math.round(panel.getSize().inPixels);
            if (width >= 176 && width <= 360 && width !== preferences.sidebarWidth) {
              void saveLayout({ sidebarWidth: width });
            }
          }}
        >
          <Panel
            id="navigation-panel"
            panelRef={navigationPanel}
            collapsible
            collapsedSize={0}
            minSize={wide ? 176 : 130}
            maxSize={wide ? 360 : "34%"}
            defaultSize={navigationVisible ? (wide ? preferences.sidebarWidth : 190) : 0}
            groupResizeBehavior="preserve-pixel-size"
          >
            {workspace && (
              <aside
                id="workspace-navigation"
                className={styles.navigation}
                hidden={!navigationVisible}
              >
                <div className={styles.workspaceBar}>
                  <Select
                    aria-label="空间"
                    value={workspace.id}
                    className={styles.workspaceChooser}
                    onChange={(id) => {
                      if (id === "new-workspace") {
                        if (!wide) setNavigationOverride(false);
                        void navigate({ to: "/workspaces/new" });
                      } else if (id !== null && id !== selected) {
                        void navigate({
                          to: "/workspaces/$workspaceId",
                          params: { workspaceId: String(id) },
                        });
                      }
                    }}
                  >
                    <Button className={styles.workspace}>
                      <SelectValue className={styles.workspaceName} />
                      <span className={styles.workspaceArrow} aria-hidden="true" />
                    </Button>
                    <Popover className={styles.popover}>
                      <ListBox className={styles.spaces}>
                        {workspaces.data?.map((item) => (
                          <ListBoxItem key={item.id} id={item.id} className={styles.spaceOption}>
                            {item.name}
                          </ListBoxItem>
                        ))}
                        <ListBoxItem id="new-workspace" className={styles.spaceOption}>
                          新建空间
                        </ListBoxItem>
                      </ListBox>
                    </Popover>
                  </Select>
                  <TooltipTrigger>
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
                      <span aria-hidden="true">⚙</span>
                    </Button>
                    <Tooltip className={styles.tooltip}>空间设置</Tooltip>
                  </TooltipTrigger>
                </div>
                {canCreate && (
                  <Button className={styles.newDocument} onPress={showCreateDocument}>
                    <span aria-hidden="true">＋</span> 新建文档
                  </Button>
                )}
                {resource.data && (
                  <SpaceTree
                    key={selected}
                    documents={documents}
                    activeDocument={documentId}
                    open={openDocument}
                  />
                )}
              </aside>
            )}
          </Panel>
          {wide && navigationVisible && (
            <Separator className={styles.separator} aria-label="调整空间目录宽度" />
          )}
          <Panel id="document-panel" minSize={wide ? 300 : "50%"}>
            <main
              ref={viewport}
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
                  {canCreate && !navigationVisible && (
                    <Button variant="primary" onPress={showCreateDocument}>
                      新建文档
                    </Button>
                  )}
                </div>
              )}
            </main>
          </Panel>
        </Group>
        {canCreate && createDocumentFor === selected && (
          <CreateDocumentDialog
            workspace={selected}
            folder={activeFolder}
            created={openCreatedDocument}
            close={() => setCreateDocumentFor(undefined)}
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
              preferences={preferences}
              save={save}
              close={() => setSettings(false)}
            />
          </Suspense>
        )}
      </div>
    </ReaderLayoutContext>
  );
}
