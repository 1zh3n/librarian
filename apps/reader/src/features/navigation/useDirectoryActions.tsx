import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type RefObject } from "react";
import { api, type DocumentSummary, type FileActionResult, type Workspace } from "../../api/client";
import { documentsQuery, workspaceKeys } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Tooltip } from "../../ui/Tooltip";
import { Feedback } from "../../ui/Feedback";
import {
  RecentlyDeletedDialog,
  deletedFilesQuery,
  restoreConflict,
  type RestoreConflict,
} from "./RecentlyDeletedDialog";
import { CreateFolderForm } from "./CreateFolderForm";
import { DraftSaveError, FileActionDialog } from "./FileActionDialog";
import {
  actionError,
  canReceiveFiles,
  foldersQuery,
  parentPath,
  type DirectoryCommand,
  type DirectorySource,
} from "./fileActions";
import styles from "../../routes/WorkspaceShell.module.css";

type DialogState = {
  source: DirectorySource;
  action: DirectoryCommand | "createFolder";
  origin: HTMLElement;
};
type Notice = {
  workspace: string;
  message: string;
  target?: FileActionResult;
  undo?: string;
  error?: string;
};
type ResultRow = { workspace: string; path: string };
export type DraftPreparation = { id: string; save: () => Promise<boolean> };

export function useDirectoryActions({
  selected,
  workspaces,
  active,
  documents,
  draft,
  showDirectory,
}: {
  selected: string;
  workspaces: readonly Workspace[];
  active: DocumentSummary | undefined;
  documents: readonly DocumentSummary[];
  draft: RefObject<DraftPreparation | undefined>;
  showDirectory: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>();
  const [deleted, setDeleted] = useState<{
    workspace: string;
    origin: HTMLElement;
    conflict?: RestoreConflict;
  }>();
  const [notice, setNotice] = useState<Notice>();
  const [revealed, setRevealed] = useState<ResultRow>();
  const [undoing, setUndoing] = useState(false);
  function start(action: DialogState["action"], source: DirectorySource, origin: HTMLElement) {
    setRevealed(undefined);
    setDialog({ action, source, origin });
  }
  function close() {
    const origin = dialog?.origin;
    setDialog(undefined);
    requestAnimationFrame(() => origin?.focus({ preventScroll: true }));
  }
  function reveal(workspace: string, path: string) {
    setRevealed({ workspace, path });
  }
  async function refreshDirectory(workspace: string) {
    await Promise.all([
      client.invalidateQueries({ queryKey: workspaceKeys.documents(workspace) }),
      client.invalidateQueries({ queryKey: foldersQuery(workspace).queryKey }),
      client.invalidateQueries({ queryKey: workspaceKeys.references(workspace) }),
      client.invalidateQueries({ queryKey: [...workspaceKeys.workspace(workspace), "search"] }),
    ]);
  }
  async function complete(result: FileActionResult, state: DialogState) {
    const { source, action } = state;
    const workspace = source.workspace.id;
    const cross = result.workspaceId !== workspace;
    const affected = documents.filter(
      (item) =>
        item.path === source.path ||
        (source.kind === "folder" && item.path.startsWith(source.path + "/")),
    );
    await Promise.all([...new Set([workspace, result.workspaceId])].map(refreshDirectory));
    if (
      (action === "delete" || (action === "move" && cross)) &&
      affected.some((item) => item.id === active?.id)
    ) {
      const remaining = client.getQueryData<DocumentSummary[]>(
        workspaceKeys.documents(workspace),
      )?.[0];
      if (remaining)
        await navigate({
          to: "/workspaces/$workspaceId/documents/$documentId",
          params: { workspaceId: workspace, documentId: remaining.id },
          replace: true,
        });
      else
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: workspace },
          replace: true,
        });
    }
    if (action !== "copy") {
      await Promise.all(
        affected.map((item) =>
          client.invalidateQueries({ queryKey: workspaceKeys.document(workspace, item.id) }),
        ),
      );
    }
    const dest =
      workspaces.find((item) => item.id === result.workspaceId)?.name ?? result.workspaceId;
    const location = [dest, parentPath(result.path) || "根目录"].join(" / ");
    setDialog(undefined);
    if (action === "delete") {
      void client.invalidateQueries({ queryKey: deletedFilesQuery(workspace).queryKey });
      setNotice({
        workspace,
        message: `已删除「${source.path}」`,
        ...(result.undoable && { undo: result.operationId }),
      });
    } else {
      const message =
        action === "renameFolder"
          ? `已重命名为「${result.path.split("/").at(-1)}」`
          : `已${action === "move" ? "移动" : "复制"}到 ${location}`;
      setNotice({ workspace, message, ...(cross && { target: result }) });
    }
    if (!cross && action !== "delete") reveal(workspace, result.path);
    else {
      const fallback = state.origin.isConnected
        ? state.origin
        : (document.querySelector<HTMLElement>("#workspace-navigation [aria-label='根目录更多']") ??
          document.getElementById("workspace-navigation"));
      requestAnimationFrame(() => fallback?.focus({ preventScroll: true }));
    }
  }
  async function view(target: FileActionResult) {
    if (target.documentId)
      await navigate({
        to: "/workspaces/$workspaceId/documents/$documentId",
        params: { workspaceId: target.workspaceId, documentId: target.documentId },
      });
    else {
      const entries = await client.fetchQuery(documentsQuery(target.workspaceId));
      const child = entries.find((item) => item.path.startsWith(target.path + "/"));
      if (child)
        await navigate({
          to: "/workspaces/$workspaceId/documents/$documentId",
          params: { workspaceId: target.workspaceId, documentId: child.id },
        });
      else
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: target.workspaceId },
        });
    }
    showDirectory();
    reveal(target.workspaceId, target.path);
  }
  async function restore(workspace: string, operationId: string, targetPath?: string) {
    const result = await api.undoFileAction(workspace, operationId, targetPath);
    const query = deletedFilesQuery(workspace);
    await client.cancelQueries({ queryKey: query.queryKey });
    client.setQueryData(
      query.queryKey,
      (prior) =>
        prior && {
          items: prior.items.filter((item) => item.operationId !== operationId),
        },
    );
    await refreshDirectory(result.workspaceId);
    setNotice((prior) => (prior?.undo === operationId ? undefined : prior));
    return result;
  }
  function openDeleted(workspace: string, origin: HTMLElement) {
    setRevealed(undefined);
    setDeleted({ workspace, origin });
  }
  async function undo(current: Notice, origin: HTMLElement) {
    if (!current.undo || undoing) return;
    setUndoing(true);
    try {
      const result = await restore(current.workspace, current.undo);
      setNotice({ workspace: result.workspaceId, message: `已恢复「${result.path}」` });
      reveal(result.workspaceId, result.path);
    } catch (error) {
      const conflict = restoreConflict(current.undo, error);
      if (conflict) {
        setRevealed(undefined);
        setDeleted({ workspace: current.workspace, origin, conflict });
      } else setNotice({ ...current, error: actionError(error) });
    } finally {
      setUndoing(false);
    }
  }
  const visibleDialog = dialog?.source.workspace.id === selected ? dialog : undefined;
  const row = revealed?.workspace === selected ? revealed : undefined;
  return {
    start,
    openDeleted,
    deletedDialog: deleted?.workspace === selected &&
      workspaces.some((space) => space.id === selected && canReceiveFiles(space)) && (
        <RecentlyDeletedDialog
          key={selected}
          workspace={selected}
          conflict={deleted.conflict}
          restore={(operationId, path) => restore(selected, operationId, path)}
          close={(result) => {
            setDeleted(undefined);
            if (result) {
              showDirectory();
              reveal(result.workspaceId, result.path);
            } else requestAnimationFrame(() => deleted.origin.focus({ preventScroll: true }));
          }}
        />
      ),
    reveal: row,
    markedPath: visibleDialog?.source.path ?? row?.path,
    dialogs:
      visibleDialog &&
      (visibleDialog.action === "createFolder" ? (
        <CreateFolderForm
          dialog
          workspace={selected}
          parent={visibleDialog.source.path}
          close={close}
          created={(path) => {
            setDialog(undefined);
            reveal(selected, path);
            setNotice({ workspace: selected, message: `已创建文件夹「${path}」` });
          }}
        />
      ) : (
        <FileActionDialog
          source={visibleDialog.source}
          action={visibleDialog.action}
          workspaces={workspaces}
          prepareSource={async () => {
            const source = visibleDialog.source;
            if (
              !active ||
              (source.kind === "document"
                ? source.documentId !== active.id
                : !active.path.startsWith(source.path + "/"))
            )
              return;
            const current = draft.current;
            if (current?.id === active.id && !(await current.save()))
              throw new DraftSaveError("此操作涉及正在编辑的文档。请先保存正文和提纲，再重试。");
          }}
          done={(result) => complete(result, visibleDialog)}
          close={close}
        />
      )),
    notice: notice?.workspace === selected && (
      <Feedback tone={notice.error ? "error" : "success"} className={styles.actionNotice}>
        <span>
          {notice.message}
          {notice.error && `。${notice.error}`}
        </span>
        {notice.target && (
          <Button
            onPress={() => {
              if (notice.target)
                void view(notice.target).catch((error) =>
                  setNotice({ ...notice, error: actionError(error) }),
                );
            }}
          >
            查看位置
          </Button>
        )}
        {notice.undo && (
          <Button
            loading={undoing}
            onPress={(event) => {
              if (event.target instanceof HTMLElement) void undo(notice, event.target);
            }}
          >
            {undoing ? "正在恢复…" : "撤销"}
          </Button>
        )}
        <Tooltip text="关闭提示" className={styles.tooltip}>
          <Button
            isIconOnly
            aria-label="关闭提示"
            isDisabled={undoing}
            onPress={() => setNotice(undefined)}
          >
            <Icon name="x" />
          </Button>
        </Tooltip>
      </Feedback>
    ),
  };
}
