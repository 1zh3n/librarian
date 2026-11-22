import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Snapshot } from "../api/client";
import documentStyles from "../features/document/DocumentPage.module.css";
import { OfflineSnapshotControl } from "../features/offline/OfflineSnapshotControl";
import { offlineAvailable } from "../features/offline/readerOffline";
import { analyzeMarkdown } from "../markdown/analyze";
import { ReaderSurface } from "../markdown/ReaderSurface";
import { isInlineImagePath } from "../markdown/imagePath";
import { relativeDocumentPath } from "../markdown/relativePath";
import { Disclosure } from "../ui/Disclosure";
import styles from "./SnapshotRoute.module.css";

const route = getRouteApi("/r/$snapshotId");

export function SnapshotRoute() {
  const { snapshotId } = route.useParams();
  const { documentId } = route.useSearch();
  const result = useQuery({
    queryKey: ["snapshots", snapshotId, documentId ?? null],
    queryFn: ({ signal }) => api.getSnapshot(snapshotId, documentId, signal),
    staleTime: 0,
    networkMode: "always",
  });
  const main = useRef<HTMLElement>(null);
  const selectedChapter = useRef<string | null>(null);
  const currentId = result.data?.snapshot.document.id;
  const focusChapter = () => {
    const heading = main.current?.querySelector("h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
    selectedChapter.current = null;
  };
  useEffect(() => {
    if (currentId && selectedChapter.current === currentId) focusChapter();
  }, [currentId]);
  const { refetch } = result;
  useEffect(() => {
    if (!offlineAvailable()) return;
    const changedIdentity = (event: MessageEvent<{ type?: string }>) => {
      if (event.data.type === "offline-identity-changed") void refetch();
    };
    navigator.serviceWorker.addEventListener("message", changedIdentity);
    return () => navigator.serviceWorker.removeEventListener("message", changedIdentity);
  }, [refetch]);
  const loginRequired = result.error instanceof ApiError && result.error.status === 401;
  const login = `/.auth/librarian/login?${new URLSearchParams({
    next: window.location.pathname + window.location.search,
  })}`;

  return (
    <main ref={main} className={documentStyles.page}>
      <meta name="referrer" content="no-referrer" />
      {result.isPending ? (
        <output className={documentStyles.message}>正在打开阅读地址…</output>
      ) : result.isError && loginRequired ? (
        <div className={documentStyles.message}>
          <p>请登录后阅读此地址。</p>
          <a href={login}>登录</a>
        </div>
      ) : result.isError ? (
        <p role="alert" className={documentStyles.message}>
          阅读地址不可用
        </p>
      ) : (
        <SnapshotReader
          key={currentId}
          snapshot={result.data.snapshot}
          offline={result.data.offline}
          onChoose={(id) => {
            selectedChapter.current = id;
            if (id === currentId) focusChapter();
          }}
        />
      )}
    </main>
  );
}

function SnapshotReader({
  snapshot,
  offline,
  onChoose,
}: {
  snapshot: Snapshot;
  offline: boolean;
  onChoose: (id: string) => void;
}) {
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const { id, document, documents, attachmentPaths, kind } = snapshot;
  const analysis = useMemo(() => analyzeMarkdown(document.markdown, document.id), [document]);
  const resolveLink = useCallback(
    (href: string) => {
      if (href.startsWith("#") || /^(?:https?:|mailto:)/iu.test(href)) return;
      const relative = relativeDocumentPath(document.path, href);
      if (!relative) return null;
      const target = documents.find((item) => item.path === relative.path);
      if (target) {
        const search = new URLSearchParams({ documentId: target.id });
        return { href: `/r/${encodeURIComponent(id)}?${search}${relative.hash}` };
      }
      if (attachmentPaths.includes(relative.path)) {
        return { href: api.snapshotAsset(id, relative.path) };
      }
      return null;
    },
    [attachmentPaths, document.path, documents, id],
  );
  const resolveImage = useCallback(
    (src: string) => {
      const relative = relativeDocumentPath(document.path, src);
      return relative && isInlineImagePath(relative.path) && attachmentPaths.includes(relative.path)
        ? api.snapshotAsset(id, relative.path)
        : null;
    },
    [attachmentPaths, document.path, id],
  );
  const titleIsFirstHeading =
    analysis.headings[0]?.level === 1 && analysis.headings[0].label === document.title;

  return (
    <>
      <header className={styles.header}>
        <p className={styles.kind}>{kind === "release" ? "固定版本" : "当前地址"}</p>
        <a
          className={styles.staticRead}
          href={`/r/${encodeURIComponent(id)}/read?documentId=${encodeURIComponent(document.id)}`}
          target="_blank"
          rel="noreferrer"
        >
          低 JS 阅读
        </a>
        {kind === "release" && <OfflineSnapshotControl key={id} id={id} offline={offline} />}
        {documents.length > 1 && (
          <Disclosure
            title={`文档目录 · ${documents.length} 篇`}
            triggerClassName={styles.directoryTrigger}
            expanded={directoryOpen}
            onChange={setDirectoryOpen}
            className={styles.directory}
          >
            <nav aria-label="阅读地址中的文档" className={styles.navigation}>
              {documents.map((item) => (
                <Link
                  key={item.id}
                  to="/r/$snapshotId"
                  params={{ snapshotId: id }}
                  search={{ documentId: item.id }}
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    setDirectoryOpen(false);
                    onChoose(item.id);
                  }}
                  aria-current={item.id === document.id ? "page" : false}
                >
                  {item.title}
                </Link>
              ))}
            </nav>
          </Disclosure>
        )}
        {!titleIsFirstHeading && <h1 className={documentStyles.title}>{document.title}</h1>}
      </header>
      <div className={documentStyles.canvas}>
        <ReaderSurface
          analysis={analysis}
          label={document.title}
          resolveLink={resolveLink}
          resolveImage={resolveImage}
        />
      </div>
    </>
  );
}
