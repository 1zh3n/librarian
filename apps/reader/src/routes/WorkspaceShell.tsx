import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
  Tooltip,
  TooltipTrigger,
} from "../ui/primitives";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { ApiError } from "../api/client";
import type { DevicePreferences, DocumentSummary } from "../api/client";
import { documentsQuery, workspacesQuery } from "../api/queries";
import { SpaceTree } from "../features/navigation/SpaceTree";
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
  ["review", "校订布局", true],
  ["custom", "自定义布局", null],
] as const;

export function WorkspaceShell() {
  const { workspaceId, documentId } = useParams({ strict: false });
  const navigate = useNavigate();
  const workspaceTool = useRouterState({
    select: ({ matches }) =>
      matches.find(
        ({ routeId }) =>
          routeId === "/workspaces/new" ||
          routeId === "/workspaces/$workspaceId/manage" ||
          routeId === "/workspaces/$workspaceId/ai",
      )?.routeId,
  });
  const creating = workspaceTool === "/workspaces/new";
  const workspaces = useQuery(workspacesQuery);
  const workspace = workspaceId
    ? workspaces.data?.find((item) => item.id === workspaceId)
    : workspaces.data?.[0];
  const selected = workspace?.id ?? "";
  const resource = useQuery({ ...documentsQuery(selected), enabled: Boolean(workspace) });
  const documents = resource.data ?? noDocuments;
  const active = documents.find((item) => item.id === documentId);
  const firstDocument = documents[0]?.id;
  const viewport = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const navigationPanel = usePanelRef();
  const { preferences, save } = useDevicePreferences(Boolean(workspaces.data));
  const focus = useReadingFocus(viewport, layout, documentId);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 801px)").matches);
  const [navigationOverride, setNavigationOverride] = useState<boolean>();
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const navigation = navigationOverride ?? preferences.navigation ?? wide;
  const navigationVisible = Boolean(workspace && navigation && !focus.active);

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
    if (!selected || documentId || workspaceTool || !firstDocument) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: firstDocument },
      replace: true,
    });
  }, [selected, documentId, firstDocument, navigate, workspaceTool]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: 0, left: 0 });
  }, [documentId, workspaceTool]);

  useEffect(() => {
    if (!selected) return;
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
  }, [selected]);

  async function saveLayout(patch: Partial<DevicePreferences>) {
    setSettingsError(false);
    try {
      await save(patch);
    } catch {
      setSettingsError(true);
    }
  }

  function openDocument(id: string) {
    if (!selected || id === documentId) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: id },
    });
    if (!wide) setNavigationOverride(false);
  }

  const workspacesUnavailable = !workspaces.data && workspaces.isError;
  const unauthorized =
    workspacesUnavailable &&
    workspaces.error instanceof ApiError &&
    workspaces.error.status === 401;
  const login = `/.auth/librarian/login?${new URLSearchParams({ next: window.location.pathname })}`;
  const focusLabel = focus.active ? "退出专注阅读" : "专注阅读";
  const commands = [
    ...(documentId ? [{ id: "focus", title: focusLabel, run: focus.toggle }] : []),
    { id: "settings", title: "阅读设置", run: () => setSettings(true) },
    {
      id: "workspace-ai",
      title: "Workspace AI",
      run: () =>
        void navigate({
          to: "/workspaces/$workspaceId/ai",
          params: { workspaceId: selected },
        }),
    },
  ];

  return (
    <ReaderLayoutContext value={{ focus, preferences, savePreferences: save }}>
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
                void saveLayout({ navigation: next, layout: "custom" });
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
            {active?.path ?? workspace?.name}
          </div>
          {workspace && (
            <div className={styles.topActions}>
              <MenuTrigger>
                <Button className={styles.button}>布局</Button>
                <Popover className={styles.popover}>
                  <Menu
                    className={styles.layoutMenu}
                    onAction={(id) => {
                      if (id === "focus") focus.toggle();
                      if (id === "settings") setSettings(true);
                      const preset = presets.find(([key]) => key === id);
                      if (preset) {
                        if (focus.active) focus.toggle();
                        setNavigationOverride(undefined);
                        void saveLayout({ layout: preset[0], navigation: preset[2] });
                      }
                    }}
                  >
                    {presets.map(([id, label]) => (
                      <MenuItem key={id} id={id} className={styles.spaceOption}>
                        {label}
                      </MenuItem>
                    ))}
                    {documentId && (
                      <MenuItem id="focus" className={styles.spaceOption}>
                        {focusLabel}
                      </MenuItem>
                    )}
                    <MenuItem id="settings" className={styles.spaceOption}>
                      阅读设置
                    </MenuItem>
                  </Menu>
                </Popover>
              </MenuTrigger>
              <Button
                aria-label="搜索文档"
                aria-keyshortcuts="Control+K Meta+K"
                className={styles.button}
                onPress={() => setSearch(true)}
              >
                搜索
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
              void saveLayout({ sidebarWidth: width, layout: "custom" });
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
                      <SelectValue />
                      <span aria-hidden="true">⌄</span>
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
                  {(workspace.canManage || workspace.canWrite) && (
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
                  )}
                </div>
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
              ) : creating ? (
                <Outlet />
              ) : !workspace ? (
                <div className={styles.state}>
                  <p>{workspaceId ? "此空间不可用" : "没有可访问的空间"}</p>
                  {!workspaceId && (
                    <Link to="/workspaces/new" className={styles.signIn}>
                      新建空间
                    </Link>
                  )}
                </div>
              ) : documentId || workspaceTool ? (
                <Outlet />
              ) : resource.isError ? (
                <p role="alert" className={styles.state}>
                  无法加载目录
                </p>
              ) : resource.isPending || firstDocument ? (
                <output className={styles.state}>正在打开空间…</output>
              ) : (
                <p className={styles.state}>这个空间还没有文档</p>
              )}
            </main>
          </Panel>
        </Group>
        {settingsError && (
          <p role="alert" className={styles.notice}>
            布局未保存，请重试。
          </p>
        )}
        {focus.announce && <output className={styles.notice}>专注阅读 · Esc 退出</output>}
        {search && selected && (
          <Suspense>
            <CommandPalette
              workspace={selected}
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
