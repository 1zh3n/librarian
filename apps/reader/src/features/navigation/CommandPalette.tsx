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
} from "react-aria-components";
import type { DocumentSummary, SearchHit } from "../../api/client";
import { searchQuery } from "../../api/queries";
import styles from "./CommandPalette.module.css";

export function CommandPalette({
  workspace,
  documents,
  onClose,
  openDocument,
}: {
  workspace: string;
  documents: readonly DocumentSummary[];
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
    enabled: Boolean(debounced),
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
  const searching = query && (query !== debounced || results.isFetching);
  const emptyMessage = searching
    ? "正在搜索…"
    : results.isError
      ? "全文搜索暂不可用"
      : "未找到文档";

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog aria-label="快速打开与全文搜索" className={styles.dialog}>
          <Autocomplete inputValue={text} onInputChange={setText} disableAutoFocusFirst>
            <SearchField aria-label="搜索文档">
              <Input ref={input} placeholder="搜索文档" className={styles.input} maxLength={256} />
            </SearchField>
            <ListBox
              aria-label="搜索结果"
              className={styles.results}
              items={Array.from(options.values())}
              renderEmptyState={() => <output className={styles.empty}>{emptyMessage}</output>}
              onAction={(id) => {
                onClose();
                openDocument(String(id));
              }}
            >
              {({ document, excerpt }) => (
                <ListBoxItem id={document.id} textValue={document.title} className={styles.result}>
                  <span>{document.title}</span>
                  <span className={styles.detail}>{excerpt || document.path}</span>
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
