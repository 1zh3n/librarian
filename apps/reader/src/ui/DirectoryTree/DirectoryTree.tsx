import { Icon } from "../Icon";
import { useMemo, useState } from "react";
import { Collection, Group, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import type { DocumentSummary } from "../../api/client";
import styles from "./DirectoryTree.module.css";

type OpenDirectoryMenu = (trigger: HTMLElement, folder: string) => void;

type Entry = {
  id: string;
  name: string;
  folder: string;
  filename?: string;
  children?: Entry[];
};

function entries(documents: readonly DocumentSummary[]) {
  const tree: Entry[] = [];
  const folders = new Map<string, Entry[]>();
  for (const document of documents) {
    const parts = document.path.split("/");
    const filename = parts.pop() ?? document.path;
    let current = tree;
    let path = "";
    for (const part of parts) {
      path += `/${part}`;
      let children = folders.get(path);
      if (!children) {
        children = [];
        folders.set(path, children);
        current.push({ id: path, name: part, folder: path.slice(1), children });
      }
      current = children;
    }
    current.push({ id: document.id, name: document.title, filename, folder: parts.join("/") });
  }
  return { tree, folders };
}

function MoreButton({
  name,
  folder,
  openMenu,
}: {
  name: string;
  folder: string;
  openMenu: OpenDirectoryMenu;
}) {
  return (
    <Tooltip text={name} className={styles.tooltip}>
      <Button
        className={styles.more}
        aria-label={name}
        aria-haspopup="menu"
        isIconOnly
        onPress={(event) => {
          if (event.target instanceof HTMLElement) openMenu(event.target, folder);
        }}
      >
        <Icon name="ellipsis" className={styles.moreIcon} />
      </Button>
    </Tooltip>
  );
}

function revealCurrentRow(row: HTMLDivElement | null) {
  const directory = row?.closest<HTMLElement>(`.${styles.directory}`);
  if (!row || !directory) return;
  // A narrow or collapsed dock may have no height when the document opens.
  const observer = new ResizeObserver(() => {
    if (!directory.clientHeight) return;
    observer.disconnect();
    const item = row.getBoundingClientRect();
    const view = directory.getBoundingClientRect();
    if (item.top < view.top) directory.scrollTop += item.top - view.top;
    else if (item.bottom > view.bottom) directory.scrollTop += item.bottom - view.bottom;
  });
  observer.observe(directory);
  return () => observer.disconnect();
}

function EntryRow({
  entry,
  open,
  openMenu,
}: {
  entry: Entry;
  open: (id: string) => void;
  openMenu: OpenDirectoryMenu | undefined;
}) {
  return (
    <TreeItem
      id={entry.id}
      textValue={entry.name}
      className={styles.row}
      {...(!entry.children && { onAction: () => open(entry.id) })}
      data-context-folder={entry.folder}
      data-context-document={entry.children ? undefined : entry.id}
      aria-description={entry.filename}
    >
      <TreeItemContent>
        {({ level, isExpanded, isSelected }) => (
          <div
            ref={isSelected ? revealCurrentRow : undefined}
            className={styles.item}
            style={{ paddingInlineStart: 8 + 14 * (level - 1) }}
          >
            {entry.children ? (
              <Button slot="chevron" className={styles.disclosure}>
                <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
              </Button>
            ) : (
              <span className={styles.leaf} aria-hidden="true">
                <Icon name="file-text" />
              </span>
            )}
            <div className={styles.labels}>
              <span title={entry.name} className={styles.label}>
                {entry.name}
              </span>
              {entry.filename && entry.filename !== entry.name + ".md" && (
                <small className={styles.label} title={entry.filename}>
                  {entry.filename}
                </small>
              )}
            </div>
            {openMenu && (
              <MoreButton name={`${entry.name}更多`} folder={entry.folder} openMenu={openMenu} />
            )}
          </div>
        )}
      </TreeItemContent>
      {entry.children && (
        <Collection items={entry.children} dependencies={[open, openMenu]}>
          {(child) => <EntryRow entry={child} open={open} openMenu={openMenu} />}
        </Collection>
      )}
    </TreeItem>
  );
}

export function DirectoryTree({
  documents,
  activeDocument,
  open,
  openMenu,
}: {
  documents: readonly DocumentSummary[];
  activeDocument: string | undefined;
  open: (id: string) => void;
  openMenu: OpenDirectoryMenu | undefined;
}) {
  const { tree, folders } = useMemo(() => entries(documents), [documents]);
  const activePath = documents.find((document) => document.id === activeDocument)?.path;
  const activeFolders = [...folders.keys()].filter((path) =>
    `/${activePath ?? ""}`.startsWith(`${path}/`),
  );
  const [expanded, setExpanded] = useState(() => ({
    activePath,
    keys: new Set(folders.size < 12 ? [...folders.keys()] : activeFolders),
  }));
  if (expanded.activePath !== activePath) {
    setExpanded({ activePath, keys: new Set([...expanded.keys, ...activeFolders]) });
  }
  return (
    <Group aria-label="目录内容" className={styles.directory} tabIndex={-1}>
      {tree.length > 0 && (
        <div className={styles.heading}>
          <span>目录</span>
          {openMenu && <MoreButton name="根目录更多" folder="" openMenu={openMenu} />}
        </div>
      )}
      <Tree
        aria-label="空间目录"
        className={styles.tree}
        items={tree}
        dependencies={[open, openMenu]}
        expandedKeys={expanded.keys}
        onExpandedChange={(keys) =>
          setExpanded({ activePath, keys: new Set(Array.from(keys, String)) })
        }
        selectionMode="single"
        selectedKeys={activeDocument ? [activeDocument] : []}
        onSelectionChange={(selection) => {
          if (selection === "all") return;
          const first = selection.values().next().value;
          if (typeof first === "string" && !folders.has(first)) open(first);
        }}
      >
        {(entry) => <EntryRow entry={entry} open={open} openMenu={openMenu} />}
      </Tree>
    </Group>
  );
}
