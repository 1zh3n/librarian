import { useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Autocomplete,
  Collection,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
} from "react-aria-components";
import { Button, ToggleButton } from "../../ui/Button";
import { SearchField } from "../../ui/SearchField";
import { Dialog } from "../../ui/Dialog";
import type { DocumentSummary, SearchHit, Workspace } from "../../api/client";
import { searchQuery } from "../../api/queries";
import { recentDocuments } from "./recentDocuments";
import styles from "./CommandPalette.module.css";

type Result = { id: string; title: string; detail?: string; run: () => void };

export function CommandPalette({
  workspace,
  workspaces,
  username,
  documents,
  commands,
  onClose,
  openDocument,
}: {
  workspace: string;
  workspaces: readonly Workspace[];
  username: string;
  documents: readonly DocumentSummary[];
  commands: readonly { id: string; title: string; run: () => void }[];
  onClose: () => void;
  openDocument: (id: string, workspace: string) => void;
}) {
  const [text, setText] = useState("");
  const [across, setAcross] = useState(false);
  const query = text.trim();
  const [debounced, setDebounced] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(query), 140);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const current = workspaces.find((item) => item.id === workspace);
  const spaces = [
    ...(current ? [current] : []),
    ...(across ? workspaces.filter((item) => item.id !== workspace) : []),
  ];
  const results = useQueries({
    queries: debounced ? spaces.map((item) => searchQuery(item.id, debounced)) : [],
  });
  const options = new Map<string, SearchHit>();
  if (debounced === query) {
    for (const result of results) {
      for (const hit of result.data ?? []) {
        if (options.size >= 20) break;
        options.set(hit.document.id, hit);
      }
    }
  }
  const recent = query
    ? []
    : recentDocuments(username, workspace).flatMap((id) => {
        const document = documents.find((item) => item.id === id);
        return document ? [document] : [];
      });
  const recentIds = new Set(recent.map((item) => item.id));
  const folded = query.toLocaleLowerCase();
  for (const document of documents) {
    if (options.size >= 20) break;
    if (
      !options.has(document.id) &&
      !recentIds.has(document.id) &&
      `${document.title} ${document.path}`.toLocaleLowerCase().includes(folded)
    ) {
      options.set(document.id, { document, excerpt: "" });
    }
  }
  const searching =
    workspace && query && (query !== debounced || results.some((entry) => entry.isFetching));
  function documentResult(document: DocumentSummary, excerpt?: string): Result {
    const space = workspaces.find((item) => item.id === document.workspaceId);
    const detail = excerpt || document.path;
    return {
      id: document.id,
      title: document.title,
      detail: across && space ? `${space.name} · ${detail}` : detail,
      run: () => openDocument(document.id, document.workspaceId),
    };
  }
  const sections = [
    { id: "recent", title: "最近打开", items: recent.map((item) => documentResult(item)) },
    {
      id: "documents",
      title: query ? "文档" : "当前空间",
      items: Array.from(options.values(), ({ document, excerpt }) =>
        documentResult(document, excerpt),
      ),
    },
    {
      id: "commands",
      title: "命令",
      items: commands.filter((command) => command.title.includes(query)),
    },
  ].filter((section) => section.items.length);
  const items = sections.flatMap((section) => section.items);
  const emptyMessage = searching
    ? "正在搜索…"
    : results.some((entry) => entry.isError)
      ? "全文搜索暂不可用"
      : workspace
        ? "未找到文档"
        : "未找到命令";
  const inputLabel = workspace ? "搜索文档" : "查找命令";

  return (
    <Dialog
      title={workspace ? "快速打开与全文搜索" : "命令"}
      showTitle={false}
      onClose={onClose}
      classes={styles}
    >
      <Autocomplete inputValue={text} onInputChange={setText} disableAutoFocusFirst>
        <div
          className={styles.toolbar}
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            onClose();
          }}
        >
          <SearchField
            label={inputLabel}
            classes={styles}
            ref={input}
            placeholder={workspace ? "搜索文档或命令" : inputLabel}
            maxLength={256}
          />
          <div className={styles.actions}>
            {current && workspaces.length > 1 && (
              <ToggleButton className={styles.scope} isSelected={across} onChange={setAcross}>
                跨空间
              </ToggleButton>
            )}
            <Button aria-label="关闭搜索" className={styles.close} onPress={onClose}>
              关闭
            </Button>
          </div>
        </div>
        <ListBox
          aria-label="搜索结果"
          className={styles.results}
          items={sections}
          renderEmptyState={() => <output className={styles.empty}>{emptyMessage}</output>}
          onAction={(id) => {
            onClose();
            items.find((item) => item.id === id)?.run();
          }}
        >
          {({ id, title, items }) => (
            <ListBoxSection id={id}>
              <Header className={styles.sectionTitle}>{title}</Header>
              <Collection items={items}>
                {({ id, title, detail }: Result) => (
                  <ListBoxItem id={id} textValue={title} className={styles.result}>
                    <span>{title}</span>
                    {detail && <span className={styles.detail}>{detail}</span>}
                  </ListBoxItem>
                )}
              </Collection>
            </ListBoxSection>
          )}
        </ListBox>
      </Autocomplete>
    </Dialog>
  );
}
