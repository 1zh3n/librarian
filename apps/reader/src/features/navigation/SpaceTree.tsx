import { useCallback, useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  Button,
  Collection,
  Group,
  Menu,
  MenuItem,
  Tooltip,
  TooltipTrigger,
  Tree,
  TreeItem,
  TreeItemContent,
} from "../../ui/primitives";
import { ContextMenuPopover } from "../../ui/ContextMenuPopover";
import type { MenuPoint } from "../../ui/ContextMenuPopover";
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

type OpenMenu = (trigger: HTMLElement, folder: string, point?: MenuPoint) => void;

function directoryMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  openMenu: OpenMenu,
) {
  if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
  if ("key" in event && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return;
  event.preventDefault();
  event.stopPropagation();
  const row = event.target.closest<HTMLElement>("[data-context-folder]");
  const trigger = row ?? event.target.closest("button") ?? event.currentTarget;
  const point =
    "button" in event && event.button >= 0 ? { x: event.clientX, y: event.clientY } : undefined;
  openMenu(trigger, row?.dataset.contextFolder ?? "", point);
}

function MoreButton({
  name,
  folder,
  openMenu,
}: {
  name: string;
  folder: string;
  openMenu: OpenMenu;
}) {
  return (
    <TooltipTrigger>
      <Button
        className={styles.more}
        aria-label={name}
        aria-haspopup="menu"
        isIconOnly
        onPress={(event) => {
          if (event.target instanceof HTMLElement) openMenu(event.target, folder);
        }}
      >
        <span aria-hidden="true" className={styles.moreIcon} />
      </Button>
      <Tooltip className={styles.tooltip}>{name}</Tooltip>
    </TooltipTrigger>
  );
}

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
      data-context-folder={entry.folder}
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

export function SpaceTree({
  documents,
  activeDocument,
  open,
  create,
}: {
  documents: readonly DocumentSummary[];
  activeDocument: string | undefined;
  open: (id: string) => void;
  create: ((folder: string, origin: HTMLElement) => void) | undefined;
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
  const [menu, setMenu] = useState<{
    trigger: HTMLElement;
    folder: string;
    point: MenuPoint | undefined;
  }>();
  const openMenu = useCallback<OpenMenu>((trigger, folder, point) => {
    trigger.focus({ preventScroll: true });
    setMenu({ trigger, folder, point });
  }, []);
  return (
    <Group
      aria-label="目录内容"
      className={styles.directory}
      tabIndex={-1}
      onContextMenu={create ? (event) => directoryMenu(event, openMenu) : undefined}
      onKeyDownCapture={create ? (event) => directoryMenu(event, openMenu) : undefined}
    >
      {tree.length > 0 && (
        <div className={styles.heading}>
          <span>目录</span>
          {create && <MoreButton name="根目录更多" folder="" openMenu={openMenu} />}
        </div>
      )}
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
      {create && menu && (
        <ContextMenuPopover
          trigger={menu.trigger}
          point={menu.point}
          close={() => setMenu(undefined)}
          className={styles.contextMenu}
        >
          <Menu
            {...initialMenuFocus}
            aria-label="目录操作"
            onAction={() => {
              setMenu(undefined);
              create(menu.folder, menu.trigger);
            }}
          >
            <MenuItem id="new-document" className={styles.menuItem}>
              新建文档…
            </MenuItem>
          </Menu>
        </ContextMenuPopover>
      )}
    </Group>
  );
}
