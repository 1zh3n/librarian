import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  Button,
  Collection,
  Menu,
  MenuItem,
  Popover,
  Tree,
  TreeItem,
  TreeItemContent,
} from "../../ui/primitives";
import type { DocumentSummary } from "../../api/client";
import styles from "./SpaceTree.module.css";

type Entry = {
  id: string;
  name: string;
  folder: string;
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
        current.push({ id: path, name: part, folder: path.slice(1), children });
      }
      current = children;
    }
    current.push({ id: document.id, name: document.title, folder: parts.join("/") });
  }
  return { tree, folders };
}

type OpenMenu = (row: HTMLElement, folder: string) => void;
// Focus the first action after the user explicitly opens the menu.
const initialMenuFocus = { autoFocus: "first" } as const;

function EntryRow({
  entry,
  open,
  openMenu,
}: {
  entry: Entry;
  open: (id: string) => void;
  openMenu: OpenMenu | undefined;
}) {
  return (
    <TreeItem
      id={entry.id}
      textValue={entry.name}
      className={styles.row}
      {...(!entry.children && { onAction: () => open(entry.id) })}
      {...(openMenu && {
        onContextMenu: (event) => {
          event.preventDefault();
          openMenu(event.currentTarget, entry.folder);
        },
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          openMenu(event.currentTarget, entry.folder);
        },
      })}
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
        <Collection items={entry.children} dependencies={[open, openMenu]}>
          {(child) => <EntryRow entry={child} open={open} openMenu={openMenu} />}
        </Collection>
      )}
    </TreeItem>
  );
}

export function SpaceTree({
  documents,
  activeDocument,
  open,
  create,
}: {
  documents: readonly DocumentSummary[];
  activeDocument: string | undefined;
  open: (id: string) => void;
  create: ((folder: string) => void) | undefined;
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
  const anchor = useRef<HTMLElement>(null);
  const [menuFolder, setMenuFolder] = useState<string>();
  const openMenu = useCallback<OpenMenu>((row, folder) => {
    anchor.current = row;
    setMenuFolder(folder);
  }, []);
  return (
    <>
      <Tree
        aria-label="空间目录"
        className={styles.tree}
        items={tree}
        dependencies={[open, create]}
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
        {(entry) => <EntryRow entry={entry} open={open} openMenu={create && openMenu} />}
      </Tree>
      {create && menuFolder !== undefined && (
        <Popover
          isOpen
          triggerRef={anchor}
          placement="bottom start"
          offset={2}
          onOpenChange={(open) => {
            if (!open) setMenuFolder(undefined);
          }}
          className={styles.contextMenu}
        >
          <Menu
            {...initialMenuFocus}
            aria-label="目录操作"
            onAction={() => {
              setMenuFolder(undefined);
              create(menuFolder);
            }}
          >
            <MenuItem id="new-document" className={styles.menuItem}>
              新建文档…
            </MenuItem>
          </Menu>
        </Popover>
      )}
    </>
  );
}
