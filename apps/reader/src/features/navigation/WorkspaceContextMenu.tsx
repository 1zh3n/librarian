import type { DirectorySource } from "./fileActions";
import type { KeyboardEvent, MouseEvent } from "react";
import { ContextMenuPopover } from "../../ui/ContextMenuPopover";
import type { MenuPoint } from "../../ui/ContextMenuPopover";
import { Menu } from "../../ui/Menu";
import { isEditingTarget } from "../reading/readingFocus";
import styles from "./WorkspaceContextMenu.module.css";

export type WorkspaceMenuTarget = {
  trigger: HTMLElement;
  folder: string;
  source?: DirectorySource;
  point: MenuPoint | undefined;
};
export type OpenWorkspaceMenu = (trigger: HTMLElement, folder: string, point?: MenuPoint) => void;

function selectionAt(target: Element, point?: MenuPoint) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (!range.intersectsNode(target)) continue;
    if (!point) return true;
    for (const rect of range.getClientRects()) {
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      )
        return true;
    }
  }
  return false;
}

export function handleWorkspaceMenu(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  open: OpenWorkspaceMenu,
) {
  const { target, currentTarget } = event;
  if (
    event.defaultPrevented ||
    !(target instanceof Element) ||
    !currentTarget.contains(target) ||
    isEditingTarget(target) ||
    target.closest('a[href], img, video, audio, [role="dialog"], [role="menu"], [role="listbox"]')
  )
    return;
  if (
    "key" in event &&
    (event.nativeEvent.isComposing ||
      (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")))
  )
    return;

  const point =
    "clientX" in event && (event.button === 2 || event.clientX || event.clientY)
      ? { x: event.clientX, y: event.clientY }
      : undefined;
  if (selectionAt(target, point)) return;
  event.preventDefault();
  event.stopPropagation();
  const row = target.closest<HTMLElement>("[data-context-folder]");
  const trigger =
    row ?? target.closest<HTMLElement>("button:not(:disabled), [tabindex]") ?? currentTarget;
  open(trigger, row?.dataset.contextFolder ?? "", point);
}

export function WorkspaceContextMenu({
  target,
  create,
  rename,
  actions,
  search,
  hasWorkspace,
  close,
}: {
  target: WorkspaceMenuTarget;
  actions: Partial<Record<"createFolder" | "move" | "copy" | "delete", () => void>>;
  rename: (() => void) | undefined;
  create: ((folder: string, origin: HTMLElement) => void) | undefined;
  search: (origin: HTMLElement) => void;
  hasWorkspace: boolean;
  close: () => void;
}) {
  const inNavigation = Boolean(target.trigger.closest("#workspace-navigation"));
  return (
    <ContextMenuPopover
      trigger={target.trigger}
      point={target.point}
      close={close}
      className={styles.contextMenu}
    >
      <Menu
        label={inNavigation ? "目录操作" : "应用操作"}
        focusFirst
        items={[
          ...(create
            ? [
                {
                  id: "new-document",
                  className: styles.menuItem,
                  label: "新建文档…",
                  run: () => {
                    close();
                    create(target.folder, target.trigger);
                  },
                },
              ]
            : []),
          {
            id: "search",
            className: styles.menuItem,
            label: hasWorkspace ? "搜索文档…" : "查找命令…",
            run: () => {
              close();
              search(target.trigger);
            },
          },
          ...(rename
            ? [
                {
                  id: "rename",
                  className: styles.menuItem,
                  label: "重命名…",
                  run: () => {
                    close();
                    rename();
                  },
                },
              ]
            : []),
          ...(
            [
              ["createFolder", "新建文件夹…"],
              ["move", "移动到…"],
              ["copy", "复制到…"],
              ["delete", "删除…"],
            ] as const
          ).flatMap(([id, label]) => {
            const run = actions[id];
            return run
              ? [
                  {
                    id,
                    label,
                    className:
                      id === "delete"
                        ? `${styles.menuItem} ${styles.destructive}`
                        : styles.menuItem,
                    run: () => {
                      close();
                      run();
                    },
                  },
                ]
              : [];
          }),
        ]}
      />
    </ContextMenuPopover>
  );
}
