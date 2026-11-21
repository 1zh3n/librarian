import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Autocomplete,
  Dialog,
  Input,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  SearchField,
} from "../../ui/primitives";
import type { DocumentSummary, SearchHit } from "../../api/client";
import { searchQuery } from "../../api/queries";
import styles from "./CommandPalette.module.css";

export function CommandPalette({
  workspace,
  documents,
  commands,
  onClose,
  openDocument,
}: {
  workspace: string;
  documents: readonly DocumentSummary[];
  commands: readonly { id: string; title: string; run: () => void }[];
  onClose: () => void;
  openDocument: (id: string) => void;
}) {
  const [text, setText] = useState("");
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

  const results = useQuery({
    ...searchQuery(workspace, debounced),
    enabled: Boolean(workspace && debounced),
  });
  const options = new Map<string, SearchHit>();
  if (debounced === query) {
    for (const hit of results.data ?? []) options.set(hit.document.id, hit);
  }
  const folded = query.toLocaleLowerCase();
  for (const document of documents) {
    if (options.size >= 20) break;
    if (
      !options.has(document.id) &&
      `${document.title} ${document.path}`.toLocaleLowerCase().includes(folded)
    ) {
      options.set(document.id, { document, excerpt: "" });
    }
  }
  const searching = workspace && query && (query !== debounced || results.isFetching);
  const visibleCommands = commands.filter((command) => command.title.includes(query));
  const items = [
    ...visibleCommands.map(({ id, title }) => ({ id, title, detail: "" })),
    ...Array.from(options.values(), ({ document, excerpt }) => ({
      id: document.id,
      title: document.title,
      detail: excerpt || document.path,
    })),
  ];
  const emptyMessage = searching
    ? "正在搜索…"
    : results.isError
      ? "全文搜索暂不可用"
      : workspace
        ? "未找到文档"
        : "未找到命令";
  const inputLabel = workspace ? "搜索文档" : "查找命令";

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog aria-label={workspace ? "快速打开与全文搜索" : "命令"} className={styles.dialog}>
          <Autocomplete inputValue={text} onInputChange={setText} disableAutoFocusFirst>
            <SearchField aria-label={inputLabel}>
              <Input
                ref={input}
                placeholder={inputLabel}
                className={styles.input}
                maxLength={256}
              />
            </SearchField>
            <ListBox
              aria-label="搜索结果"
              className={styles.results}
              items={items}
              renderEmptyState={() => <output className={styles.empty}>{emptyMessage}</output>}
              onAction={(id) => {
                onClose();
                const command = visibleCommands.find((item) => item.id === id);
                if (command) command.run();
                else openDocument(String(id));
              }}
            >
              {({ id, title, detail }) => (
                <ListBoxItem id={id} textValue={title} className={styles.result}>
                  <span>{title}</span>
                  {detail && <span className={styles.detail}>{detail}</span>}
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
