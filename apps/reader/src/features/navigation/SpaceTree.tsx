import { useMemo } from "react";
import { Button, Collection, Tree, TreeItem, TreeItemContent } from "../../ui/primitives";
import type { DocumentSummary } from "../../api/client";
import styles from "./SpaceTree.module.css";

type Entry = {
  id: string;
  name: string;
  children?: Entry[];
};

function entries(documents: readonly DocumentSummary[]) {
  const tree: Entry[] = [];
  const folders = new Map<string, Entry[]>();
  for (const document of documents) {
    const parts = document.path.split("/");
    parts.pop();
    let current = tree;
    let path = "";
    for (const part of parts) {
      path += `/${part}`;
      let children = folders.get(path);
      if (!children) {
        children = [];
        folders.set(path, children);
        current.push({ id: path, name: part, children });
      }
      current = children;
    }
    current.push({ id: document.id, name: document.title });
  }
  return { tree, folders };
}

function EntryRow({ entry, open }: { entry: Entry; open: (id: string) => void }) {
  return (
    <TreeItem
      id={entry.id}
      textValue={entry.name}
      className={styles.row}
      {...(!entry.children && { onAction: () => open(entry.id) })}
    >
      <TreeItemContent>
        {({ level, isExpanded }) => (
          <div className={styles.item} style={{ paddingInlineStart: 8 + 14 * (level - 1) }}>
            {entry.children ? (
              <Button slot="chevron" className={styles.disclosure}>
                <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
              </Button>
            ) : (
              <span className={styles.leaf} aria-hidden="true">
                •
              </span>
            )}
            <span title={entry.name} className={styles.label}>
              {entry.name}
            </span>
          </div>
        )}
      </TreeItemContent>
      {entry.children && (
        <Collection items={entry.children}>
          {(child) => <EntryRow entry={child} open={open} />}
        </Collection>
      )}
    </TreeItem>
  );
}

export function SpaceTree({
  documents,
  activeDocument,
  open,
}: {
  documents: readonly DocumentSummary[];
  activeDocument: string | undefined;
  open: (id: string) => void;
}) {
  const { tree, folders } = useMemo(() => entries(documents), [documents]);
  const activePath = documents.find((document) => document.id === activeDocument)?.path;
  const activeFolders = [...folders.keys()].filter((path) =>
    `/${activePath ?? ""}`.startsWith(`${path}/`),
  );
  return (
    <Tree
      aria-label="空间目录"
      className={styles.tree}
      items={tree}
      defaultExpandedKeys={folders.size < 12 ? [...folders.keys()] : activeFolders}
      selectionMode="single"
      selectedKeys={activeDocument ? [activeDocument] : []}
      onSelectionChange={(selection) => {
        if (selection === "all") return;
        const first = selection.values().next().value;
        if (typeof first === "string" && !folders.has(first)) open(first);
      }}
    >
      {(entry) => <EntryRow entry={entry} open={open} />}
    </Tree>
  );
}
