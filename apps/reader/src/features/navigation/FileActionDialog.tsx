import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type FileActionRequest,
  type FileActionResult,
  type Workspace,
} from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspacesQuery } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { Field, Select } from "../../ui/Forms";
import { CreateFolderForm } from "./CreateFolderForm";
import {
  accessMessage,
  actionError,
  canReceiveFiles,
  foldersQuery,
  joinPath,
  parentPath,
  validFolderName,
  type DirectoryCommand,
  type DirectorySource,
} from "./fileActions";
import styles from "../document/CreateDocumentDialog.module.css";

const verb = { move: "移动", copy: "复制", delete: "删除", renameFolder: "重命名" } as const;

export function FileActionDialog({
  source,
  action,
  workspaces,
  prepareSource,
  done,
  close,
}: {
  source: DirectorySource;
  action: DirectoryCommand;
  workspaces: readonly Workspace[];
  prepareSource: () => Promise<void>;
  done: (result: FileActionResult) => Promise<void> | void;
  close: () => void;
}) {
  const client = useQueryClient();
  const destinations = workspaces.filter(canReceiveFiles);
  const transfer = action === "move" || action === "copy";
  const [space, setSpace] = useState(() =>
    transfer && !canReceiveFiles(source.workspace)
      ? (destinations[0]?.id ?? "")
      : source.workspace.id,
  );
  const [folder, setFolder] = useState(() =>
    space === source.workspace.id ? parentPath(source.path) : "",
  );
  const filename = source.path.split("/").at(-1) ?? source.path;
  const [name, setName] = useState(filename);
  const nameField = useRef<HTMLInputElement>(null);
  const newFolderButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (action === "renameFolder") {
      nameField.current?.focus();
      nameField.current?.select();
    }
  }, [action]);
  const [adding, setAdding] = useState(false);
  const folderList = useQuery({ ...foldersQuery(space), enabled: transfer && Boolean(space) });
  const paths = new Set(folderList.data?.folders);
  if (folder) paths.add(folder);
  const request: FileActionRequest = {
    action: action === "renameFolder" ? "move" : action,
    sourcePath: source.path,
    sourceKind: source.kind,
    ...(source.documentId && { expectedDocumentId: source.documentId }),
    ...(source.folderId && { expectedFolderId: source.folderId }),
    ...(action !== "delete" && {
      targetWorkspace: space,
      targetPath: joinPath(folder, action === "renameFolder" ? name.trim() : filename),
    }),
  };
  const inside =
    space === source.workspace.id &&
    source.kind === "folder" &&
    (folder === source.path || folder.startsWith(source.path + "/"));
  const same = space === source.workspace.id && source.path === request.targetPath;
  const validName = action !== "renameFolder" || validFolderName(name);
  const canPreview =
    action === "delete" ||
    (Boolean(space) &&
      !same &&
      !inside &&
      validName &&
      (!transfer || destinations.some((item) => item.id === space)));
  const preview = useQuery({
    queryKey: ["file-action-preview", source.workspace.id, request],
    queryFn: async ({ signal }) => {
      await prepareSource();
      signal.throwIfAborted();
      return api.previewFileAction(source.workspace.id, request, signal);
    },
    enabled: canPreview && action !== "renameFolder",
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  type Attempt = FileActionRequest & { operationId: string; token: string };
  const attempt = useRef<Attempt>(undefined);
  const [notice, setNotice] = useState("");
  const apply = useMutation({
    mutationFn: async (prepared: Attempt | undefined) => {
      // A replay must retrieve the receipt even when the first request removed the source.
      if (prepared && prepared !== attempt.current) await prepareSource();
      let payload = prepared;
      if (!payload) {
        const checked = await preview.refetch({ cancelRefetch: false });
        if (!checked.data || checked.error) throw checked.error ?? new Error("Preview unavailable");
        payload = { ...request, token: checked.data.token, operationId: operationId() };
      }
      attempt.current = payload;
      try {
        return await api.applyFileAction(source.workspace.id, payload);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return api.applyFileAction(source.workspace.id, payload);
      }
    },
    onSuccess: done,
    onError: async (error) => {
      if (error instanceof ApiError) {
        if (error.status < 500 && error.status !== 408) attempt.current = undefined;
        if (error.code === "file_action_changed") {
          setNotice(actionError(error));
          await preview.refetch();
        }
        if (error.status === 403)
          await client.invalidateQueries({ queryKey: workspacesQuery.queryKey, exact: true });
      }
    },
  });
  function clearAttempt() {
    attempt.current = undefined;
    setNotice("");
    apply.reset();
  }
  const busy = apply.isPending;
  const stale = apply.error instanceof ApiError && apply.error.code === "file_action_changed";
  const problem = apply.error && !stale ? apply.error : canPreview && preview.error;
  const access =
    canPreview && transfer && preview.data ? accessMessage(action, preview.data.access) : undefined;
  const kind = source.kind === "folder" ? "文件夹" : "文档";
  const title = transfer ? verb[action] + "到" : verb[action] + kind;
  const submit = transfer
    ? verb[action] + "到此处"
    : action === "renameFolder"
      ? "保存名称"
      : "删除";
  const uncertain =
    apply.isError &&
    (apply.error instanceof TypeError ||
      (apply.error instanceof ApiError && apply.error.status >= 500));
  const ready =
    !adding &&
    !busy &&
    (uncertain ||
      (canPreview && (action === "renameFolder" || (preview.isSuccess && !preview.isFetching))));
  function submitAction() {
    if (!ready) return;
    const payload =
      attempt.current ??
      (preview.data
        ? {
            ...request,
            token: preview.data.token,
            operationId: operationId(),
          }
        : undefined);
    setNotice("");
    apply.mutate(payload);
  }
  return (
    <Dialog title={title} classes={styles} busy={busy || adding} onClose={close}>
      <div className={styles.form}>
        <div className={styles.source}>
          <strong>{filename}</strong>
          <span className={styles.location}>
            来源　{source.workspace.name} / {source.path}
          </span>
        </div>
        {transfer && (
          <>
            <Select
              label="目标空间"
              value={space}
              disabled={busy || adding}
              entries={destinations.map((w) => ({ value: w.id, label: w.name }))}
              onChange={(id) => {
                clearAttempt();
                setSpace(id);
                setFolder("");
              }}
            />
            <Select
              label="目标目录"
              value={folder || "/"}
              disabled={busy || adding || !folderList.isSuccess}
              entries={[
                { value: "/", label: "根目录" },
                ...[...paths].map((path) => ({ value: path, label: path })),
              ]}
              onChange={(value) => {
                clearAttempt();
                setFolder(value === "/" ? "" : value);
              }}
            />
            {folderList.isError && (
              <Feedback tone="error" className={styles.error}>
                无法加载目录。<Button onPress={() => void folderList.refetch()}>重试</Button>
              </Feedback>
            )}
            {!adding && (
              <Button
                ref={newFolderButton}
                className={styles.newFolder}
                isDisabled={busy || !folderList.isSuccess}
                onPress={() => setAdding(true)}
              >
                新建文件夹
              </Button>
            )}
            {adding && (
              <CreateFolderForm
                workspace={space}
                parent={folder}
                close={() => {
                  setAdding(false);
                  requestAnimationFrame(() => newFolderButton.current?.focus());
                }}
                created={(path) => {
                  clearAttempt();
                  setFolder(path);
                  setAdding(false);
                }}
              />
            )}
          </>
        )}
        {action === "renameFolder" && (
          <Field
            label="文件夹名称"
            ref={nameField}
            required
            readOnly={busy}
            value={name}
            onChange={(v) => {
              clearAttempt();
              setName(v);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || !canPreview || busy)
                return;
              event.preventDefault();
              submitAction();
            }}
          />
        )}
        {transfer && !adding && (inside || same) && (
          <p className={styles.location}>
            {inside ? "请选择此文件夹及其子目录以外的位置。" : "请选择其他目录，或新建目标文件夹。"}
          </p>
        )}
        {!validName && (
          <Feedback tone="error" className={styles.error}>
            请输入有效的文件夹名称。
          </Feedback>
        )}
        {action === "delete" && preview.data && (
          <p className={styles.detail}>
            {source.kind === "folder"
              ? `将删除此文件夹及其中的 ${preview.data.fileCount} 个文件。`
              : "将删除此文档及其提纲。"}
            删除后可以撤销。
          </p>
        )}
        {!adding && (
          <>
            {canPreview && preview.isFetching && !busy && (
              <Feedback className={styles.location}>正在检查文件和访问权限…</Feedback>
            )}
            {notice && <Feedback>{notice}</Feedback>}
            {problem && (
              <Feedback tone="error" className={styles.error}>
                {uncertain
                  ? "未收到操作回执。请重试以确认本次操作的结果。"
                  : problem instanceof DraftSaveError
                    ? problem.message
                    : actionError(problem)}
                {preview.isError && (
                  <Button onPress={() => void preview.refetch()}>重新检查</Button>
                )}
              </Feedback>
            )}
            {access && <Feedback className={styles.access}>{access}</Feedback>}
            <div className={styles.actions}>
              <Button isDisabled={busy} onPress={close}>
                取消
              </Button>
              <Button
                variant="primary"
                className={action === "delete" ? styles.deleteButton : ""}
                loading={busy}
                isDisabled={!ready}
                onPress={submitAction}
              >
                {busy ? `正在${verb[action]}…` : submit}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
export class DraftSaveError extends Error {}
