import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
} from "react-aria-components";
import { ApiError } from "../api/client";
import type { DocumentSummary } from "../api/client";
import { documentsQuery, workspacesQuery } from "../api/queries";
import { SpaceTree } from "../features/navigation/SpaceTree";
import styles from "./WorkspaceShell.module.css";

const noDocuments: readonly DocumentSummary[] = [];
const CommandPalette = lazy(() =>
  import("../features/navigation/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);

export function WorkspaceShell() {
  const { workspaceId, documentId } = useParams({ strict: false });
  const navigate = useNavigate();
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
  const [navigation, setNavigation] = useState(
    () => window.matchMedia("(min-width: 801px)").matches,
  );
  const [search, setSearch] = useState(false);

  useEffect(() => {
    if (!selected || documentId || !firstDocument) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: firstDocument },
      replace: true,
    });
  }, [selected, documentId, firstDocument, navigate]);

  useEffect(() => {
    viewport.current?.scrollTo({ top: 0, left: 0 });
  }, [documentId]);

  useEffect(() => {
    if (!selected) return;
    function shortcut(event: KeyboardEvent) {
      if (
        !event.isComposing &&
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

  function openDocument(id: string) {
    if (!selected || id === documentId) return;
    void navigate({
      to: "/workspaces/$workspaceId/documents/$documentId",
      params: { workspaceId: selected, documentId: id },
    });
    if (window.matchMedia("(max-width: 800px)").matches) setNavigation(false);
  }

  const unauthorized = workspaces.error instanceof ApiError && workspaces.error.status === 401;
  const login = `/.auth/librarian/login?${new URLSearchParams({ next: window.location.pathname })}`;

  return (
    <div className={styles.application}>
      <header className={styles.bar}>
        {workspace ? (
          <ToggleButton
            aria-label={navigation ? "收起目录" : "展开目录"}
            aria-controls="workspace-navigation"
            className={styles.button}
            isSelected={navigation}
            onChange={setNavigation}
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
          <Button
            aria-label="搜索文档"
            aria-keyshortcuts="Control+K Meta+K"
            className={styles.button}
            onPress={() => setSearch(true)}
          >
            搜索
          </Button>
        )}
      </header>
      <div
        className={styles.columns}
        data-navigation={Boolean(workspace && navigation) || undefined}
      >
        {workspace && (
          <aside id="workspace-navigation" className={styles.navigation} hidden={!navigation}>
            <Select
              aria-label="空间"
              value={workspace.id}
              onChange={(id) => {
                if (id !== null && id !== selected) {
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
                <ListBox items={workspaces.data ?? []} className={styles.spaces}>
                  {(item) => (
                    <ListBoxItem id={item.id} className={styles.spaceOption}>
                      {item.name}
                    </ListBoxItem>
                  )}
                </ListBox>
              </Popover>
            </Select>
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
        <main ref={viewport} className={styles.viewport}>
          {unauthorized ? (
            <div className={styles.state}>
              <h1>登录 Librarian</h1>
              <a className={styles.signIn} href={login}>
                登录
              </a>
            </div>
          ) : workspaces.isError ? (
            <p role="alert" className={styles.state}>
              无法加载空间
            </p>
          ) : workspaces.isPending ? (
            <output className={styles.state}>正在加载空间…</output>
          ) : !workspace ? (
            <p className={styles.state}>{workspaceId ? "此空间不可用" : "没有可访问的空间"}</p>
          ) : documentId ? (
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
      </div>
      {search && selected && (
        <Suspense>
          <CommandPalette
            workspace={selected}
            documents={documents}
            onClose={() => setSearch(false)}
            openDocument={openDocument}
          />
        </Suspense>
      )}
    </div>
  );
}
