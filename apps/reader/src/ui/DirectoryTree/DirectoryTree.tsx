import { Icon } from "../Icon";
import { useMemo, useRef, useState } from "react";
import { Collection, Group, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import { Button } from "../Button";
import { Tooltip, type TooltipPlacement } from "../Tooltip";
import type { DocumentSummary } from "../../api/client";
import { fileName } from "../../features/navigation/fileName";
import styles from "./DirectoryTree.module.css";

type RevealRow = { path: string; mount: (item: HTMLDivElement | null) => (() => void) | undefined };

type OpenDirectoryMenu = (trigger: HTMLElement, folder: string) => void;

type Entry = {
  id: string;
  name: string;
  folder: string;
  filename?: string;
  children?: Entry[];
};

const noFolders: readonly string[] = [];

function entries(documents: readonly DocumentSummary[], folderPaths: readonly string[]) {
  const tree: Entry[] = [];
  const folders = new Map<string, Entry[]>();
  function addFolder(parts: string[]) {
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
    return current;
  }
  for (const document of documents) {
    const parts = document.path.split("/");
    const filename = fileName(document.path);
    parts.pop();
    addFolder(parts).push({
      id: document.id,
      name: filename,
      filename,
      folder: parts.join("/"),
    });
  }
  for (const folder of folderPaths) addFolder(folder.split("/"));
  return { tree, folders };
}

function MoreButton({
  name,
  folder,
  tooltipPlacement = "top",
  openMenu,
}: {
  name: string;
  folder: string;
  tooltipPlacement?: TooltipPlacement;
  openMenu: OpenDirectoryMenu;
}) {
  return (
    <Tooltip text={name} className={styles.tooltip} placement={tooltipPlacement}>
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
  markedPath,
  revealRow,
  toggle,
}: {
  revealRow: RevealRow | undefined;
  markedPath: string | undefined;
  entry: Entry;
  open: (id: string) => void;
  openMenu: OpenDirectoryMenu | undefined;
  toggle: (id: string) => void;
}) {
  const path = [entry.folder, entry.filename].filter(Boolean).join("/");
  return (
    <TreeItem
      id={entry.id}
      textValue={entry.name}
      className={styles.row}
      {...(!entry.children && { onAction: () => open(entry.id) })}
      onClick={(event) => {
        if (!entry.children) return;
        if (event.target instanceof Element && event.target.closest("button, a")) return;
        toggle(entry.id);
      }}
      data-context-folder={entry.folder}
      data-context-path={path}
      data-command-target={path === markedPath || undefined}
      data-context-document={entry.children ? undefined : entry.id}
    >
      <TreeItemContent>
        {({ level, isExpanded, isSelected }) => (
          <div
            ref={
              revealRow?.path === path ? revealRow.mount : isSelected ? revealCurrentRow : undefined
            }
            className={styles.item}
            style={{ paddingInlineStart: 8 + 14 * (level - 1) }}
          >
            {entry.children?.length ? (
              <Button isIconOnly slot="chevron" className={styles.disclosure}>
                <Icon name={isExpanded ? "chevron-down" : "chevron-right"} />
              </Button>
            ) : (
              <span className={styles.leaf} aria-hidden="true">
                <Icon name={entry.children ? "folder" : "file-text"} />
              </span>
            )}
            <div className={styles.labels}>
              <span title={entry.name} className={styles.label}>
                {entry.name}
              </span>
            </div>
            {openMenu && (
              <MoreButton name={`${entry.name}更多`} folder={entry.folder} openMenu={openMenu} />
            )}
          </div>
        )}
      </TreeItemContent>
      {entry.children && (
        <Collection
          items={entry.children}
          dependencies={[open, openMenu, markedPath, revealRow, toggle]}
        >
          {(child) => (
            <EntryRow
              entry={child}
              open={open}
              openMenu={openMenu}
              markedPath={markedPath}
              revealRow={revealRow}
              toggle={toggle}
            />
          )}
        </Collection>
      )}
    </TreeItem>
  );
}

export function DirectoryTree({
  documents,
  folderPaths = noFolders,
  reveal,
  markedPath,
  activeDocument,
  open,
  openMenu,
  rootMenu = Boolean(openMenu),
}: {
  folderPaths?: readonly string[] | undefined;
  reveal?: { path: string } | undefined;
  markedPath?: string | undefined;
  rootMenu?: boolean;
  documents: readonly DocumentSummary[];
  activeDocument: string | undefined;
  open: (id: string) => void;
  openMenu: OpenDirectoryMenu | undefined;
}) {
  const { tree, folders } = useMemo(
    () => entries(documents, folderPaths),
    [documents, folderPaths],
  );
  const activePath = documents.find((document) => document.id === activeDocument)?.path;
  const activeFolders = [...folders.keys()].filter((path) =>
    `/${activePath ?? ""}`.startsWith(`${path}/`),
  );
  const revealFolders: string[] = [];
  let parent = "";
  for (const part of reveal?.path.split("/") ?? []) {
    parent += `/${part}`;
    revealFolders.push(parent);
  }
  const [expanded, setExpanded] = useState(() => ({
    activePath,
    reveal,
    keys: new Set([...(folders.size < 12 ? folders.keys() : activeFolders), ...revealFolders]),
  }));
  if (expanded.activePath !== activePath || expanded.reveal !== reveal) {
    setExpanded({
      activePath,
      reveal,
      keys: new Set([...expanded.keys, ...activeFolders, ...revealFolders]),
    });
  }
  function toggle(id: string) {
    setExpanded((current) => {
      const keys = new Set(current.keys);
      if (keys.has(id)) keys.delete(id);
      else keys.add(id);
      return { ...current, keys };
    });
  }

  const lastReveal = useRef<typeof reveal>(undefined);
  const revealRow = useMemo<RevealRow | undefined>(
    () =>
      reveal && {
        path: reveal.path,
        mount: (item) => {
          const row = item?.closest<HTMLElement>("[data-context-path]");
          if (!row || lastReveal.current === reveal) return;
          // React Aria may commit the new row after the collection data updates.
          // Observe that row itself so it can receive focus as soon as it is visible.
          const observer = new ResizeObserver(() => {
            if (!row.getClientRects().length) return;
            observer.disconnect();
            row.focus({ preventScroll: true });
            row.scrollIntoView({ block: "nearest" });
            lastReveal.current = reveal;
          });
          observer.observe(row);
          return () => observer.disconnect();
        },
      },
    [reveal],
  );
  return (
    <Group aria-label="目录内容" className={styles.directory} tabIndex={-1}>
      {(tree.length > 0 || rootMenu) && (
        <div className={styles.heading}>
          <span>目录</span>
          {openMenu && rootMenu && (
            <MoreButton name="根目录更多" folder="" tooltipPlacement="start" openMenu={openMenu} />
          )}
        </div>
      )}
      <Tree
        aria-label="空间目录"
        className={styles.tree}
        items={tree}
        dependencies={[open, openMenu, markedPath, revealRow, toggle]}
        expandedKeys={expanded.keys}
        onExpandedChange={(keys) =>
          setExpanded({ activePath, reveal, keys: new Set(Array.from(keys, String)) })
        }
        selectionMode="single"
        selectedKeys={activeDocument ? [activeDocument] : []}
        onSelectionChange={(selection) => {
          if (selection === "all") return;
          const first = selection.values().next().value;
          if (typeof first === "string" && !folders.has(first)) open(first);
        }}
      >
        {(entry) => (
          <EntryRow
            entry={entry}
            open={open}
            openMenu={openMenu}
            markedPath={markedPath}
            revealRow={revealRow}
            toggle={toggle}
          />
        )}
      </Tree>
    </Group>
  );
}
