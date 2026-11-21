import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type DeletedFileAction, type FileActionResult } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { Field, Form } from "../../ui/Forms";
import { Icon } from "../../ui/Icon";
import { FolderPicker } from "./FolderPicker";
import { actionError, fileActionName, foldersQuery, joinPath, parentPath } from "./fileActions";
import dialogStyles from "../document/CreateDocumentDialog.module.css";
import styles from "./RecentlyDeletedDialog.module.css";

export function deletedFilesQuery(workspace: string) {
  return queryOptions({
    queryKey: [...workspaceKeys.workspace(workspace), "deleted-files"],
    queryFn: ({ signal }) => api.deletedFileActions(workspace, signal),
    staleTime: 0,
    retry: false,
  });
}

export type RestoreConflict = { id: string; reason: "occupied" | "missing" };

export function restoreConflict(id: string, error: unknown): RestoreConflict | undefined {
  if (error instanceof ApiError) {
    if (error.code === "path_exists") return { id, reason: "occupied" };
    if (error.code === "restore_location_unavailable") return { id, reason: "missing" };
  }
  return undefined;
}

type Restore = (operationId: string, targetPath?: string) => Promise<FileActionResult>;

function RestoreLocation({
  workspace,
  item,
  busy,
  failure,
  reason,
  clearError,
  cancel,
  submit,
}: {
  workspace: string;
  item: DeletedFileAction;
  busy: boolean;
  failure: string | undefined;
  reason: RestoreConflict["reason"];
  clearError: () => void;
  cancel: () => void;
  submit: (path: string) => void;
}) {
  const folders = useQuery({ ...foldersQuery(workspace), refetchOnMount: "always" });
  const [selectedParent, setParent] = useState(reason === "missing" ? "" : parentPath(item.path));
  const [name, setName] = useState(item.path.split("/").at(-1) ?? "");
  const [creating, setCreating] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const parent = folders.data?.folders.includes(selectedParent) ? selectedParent : "";
  const filename = fileActionName(name, item.sourceKind);
  const path = filename ? joinPath(parent, filename) : "";
  const ready =
    folders.isSuccess && !folders.isFetching && !busy && Boolean(path) && path !== item.path;
  return (
    <div className={dialogStyles.form}>
      <div className={dialogStyles.source}>
        <strong>{item.path}</strong>
        <p className={dialogStyles.location}>
          {reason === "missing"
            ? "原文件夹已不存在，请选择恢复位置。"
            : "原位置已有同名项目。选择其他目录或名称即可保留两份。"}
        </p>
      </div>
      <FolderPicker
        workspace={workspace}
        value={parent}
        onChange={(value) => {
          clearError();
          setParent(value);
        }}
        disabled={busy}
        creating={creating}
        onCreatingChange={setCreating}
      />
      {!creating && (
        <Form
          className={dialogStyles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) submit(path);
          }}
        >
          <Field
            ref={field}
            label="名称"
            value={name}
            onChange={(value) => {
              clearError();
              setName(value);
            }}
            readOnly={busy}
            required
          />
          {(failure || (name.trim() && !filename)) && (
            <Feedback tone="error" className={dialogStyles.error}>
              {failure || "请使用有效名称，避开隐藏文件和提纲文件名。"}
            </Feedback>
          )}
          <div className={dialogStyles.actions}>
            <Button variant="outline" isDisabled={busy} onPress={cancel}>
              返回列表
            </Button>
            <Button type="submit" variant="primary" loading={busy} isDisabled={!ready}>
              恢复到此处
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}

export function RecentlyDeletedDialog({
  workspace,
  conflict,
  restore,
  close,
}: {
  workspace: string;
  conflict: RestoreConflict | undefined;
  restore: Restore;
  close: (restored?: FileActionResult) => void;
}) {
  const client = useQueryClient();
  const list = useQuery(deletedFilesQuery(workspace));
  const [editing, setEditing] = useState(conflict);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [lastRestore, setLastRestore] = useState<FileActionResult>();
  const [focus, setFocus] = useState<{ id?: string }>();
  const container = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const items = list.data?.items;
  const item = !list.isError && items?.find((entry) => entry.operationId === editing?.id);
  useEffect(() => {
    if (!focus) return;
    (
      Array.from(container.current?.querySelectorAll<HTMLButtonElement>("li button") ?? []).find(
        (button) => button.closest("li")?.dataset.operation === focus.id,
      ) ?? closeButton.current
    )?.focus({ preventScroll: true });
  }, [focus]);
  function back() {
    setFocus(editing ? { id: editing.id } : {});
    setEditing(undefined);
    setFailure(undefined);
  }
  async function recover(entry: DeletedFileAction, targetPath?: string) {
    if (busy) return;
    setBusy(entry.operationId);
    setFailure(undefined);
    try {
      const result = await restore(entry.operationId, targetPath);
      setLastRestore(result);
      setEditing(undefined);
      const next = items?.find((other) => other.operationId !== entry.operationId);
      setFocus(next ? { id: next.operationId } : {});
    } catch (error) {
      const conflict = restoreConflict(entry.operationId, error);
      if (conflict && !targetPath) setEditing(conflict);
      else if (targetPath && error instanceof ApiError && error.code === "file_action_changed") {
        void client.invalidateQueries({ queryKey: foldersQuery(workspace).queryKey });
        setFailure({ id: entry.operationId, message: "目标目录已更改，请重新选择恢复位置。" });
      } else setFailure({ id: entry.operationId, message: actionError(error) });
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <Dialog
      title={item ? "选择恢复位置" : "最近删除"}
      classes={dialogStyles}
      busy={Boolean(busy)}
      onClose={item ? back : () => close(lastRestore)}
    >
      {item && editing ? (
        <RestoreLocation
          key={item.operationId}
          workspace={workspace}
          item={item}
          busy={Boolean(busy)}
          failure={failure?.message}
          reason={editing.reason}
          clearError={() => setFailure(undefined)}
          cancel={back}
          submit={(path) => void recover(item, path)}
        />
      ) : (
        <div className={dialogStyles.form} ref={container}>
          {list.isPending ? (
            <Feedback>正在读取最近删除…</Feedback>
          ) : list.isError ? (
            <div className={styles.retry}>
              <Feedback tone="error" className={dialogStyles.error}>
                无法读取最近删除。{actionError(list.error)}
              </Feedback>
              <Button
                variant="outline"
                loading={list.isFetching}
                onPress={() => void list.refetch()}
              >
                重试
              </Button>
            </div>
          ) : items?.length ? (
            <ul className={styles.list} aria-label="已删除的项目">
              {items.map((entry) => (
                <li
                  className={styles.item}
                  key={entry.operationId}
                  data-operation={entry.operationId}
                >
                  <div className={styles.entry}>
                    <Icon name={entry.sourceKind === "folder" ? "folder" : "file-text"} />
                    <div className={styles.identity}>
                      <strong>{entry.path.split("/").at(-1)}</strong>
                      <span>{entry.path.includes("/") ? entry.path : "根目录"}</span>
                      {entry.sourceKind === "folder" && <span>{entry.fileCount} 个文件</span>}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    loading={busy === entry.operationId}
                    isDisabled={Boolean(busy)}
                    onPress={() => void recover(entry)}
                  >
                    恢复
                  </Button>
                  {failure?.id === entry.operationId && (
                    <Feedback tone="error" className={styles.rowError}>
                      {failure.message}
                    </Feedback>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>没有可恢复的项目。</p>
          )}
          {lastRestore && (
            <Feedback tone="success" className={styles.success}>
              已恢复「{lastRestore.path}」
            </Feedback>
          )}
          <div className={dialogStyles.actions}>
            <Button
              ref={closeButton}
              variant="outline"
              isDisabled={Boolean(busy)}
              onPress={() => close(lastRestore)}
            >
              关闭
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
