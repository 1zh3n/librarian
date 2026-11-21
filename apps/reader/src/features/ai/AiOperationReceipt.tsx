import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AiOperation } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, ToggleButton } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import styles from "./AiPanel.module.css";

type Decision = "confirm" | "cancel" | "undo";

export function AiOperationReceipt({
  operation,
  writable,
  update,
  afterCancel,
}: {
  operation: AiOperation;
  writable: boolean;
  update: (operation: AiOperation) => void;
  afterCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmation = operation.confirmation;
  const plan = confirmation?.plan;
  const request = plan?.request;
  async function apply(kind: Decision) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "undo") {
        const receipt = await api.undoAiOperation(operation.id);
        update({ ...operation, undoCommitId: receipt.commitId });
      } else if (confirmation) {
        const updated =
          kind === "confirm"
            ? await api.confirmAiOperation(operation.id, confirmation.id)
            : await api.cancelAiConfirmation(operation.id, confirmation.id);
        update(updated);
        if (kind === "cancel") afterCancel();
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setError("文件版本已更新，请检查当前内容。");
      } else if (cause instanceof ApiError && [403, 404].includes(cause.status)) {
        setError("当前权限或原授权已变更，请重新核对工作区权限。");
      } else {
        setError(
          {
            confirm: "无法确认操作，请重试。",
            cancel: "无法取消操作，请重试。",
            undo: "无法撤销操作，请重试。",
          }[kind],
        );
      }
      try {
        update(await api.getAiOperation(operation.id));
      } catch {
        /* Keep the reviewed plan visible. */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {confirmation && (
        <section className={styles.changeList} aria-label="待确认的操作">
          {request?.kind === "move" ? (
            <p>
              <strong>
                {request.from} → {request.to}
              </strong>
            </p>
          ) : (
            <p>
              {request?.kind === "delete"
                ? "将删除以下文档和对应提纲"
                : "以下文件需要确认后才能更改。"}
            </p>
          )}
          <ul aria-label="受影响的路径">
            {confirmation.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {plan && plan.pathLinks.length > 0 && (
            <>
              <p>受影响的内链</p>
              <ul aria-label="受影响的内链">
                {plan.pathLinks.map((link) => (
                  <li key={JSON.stringify([link.from, link.to])}>
                    {link.from} → {link.to}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan?.partialLinks && <Feedback>仅显示扫描范围内的内链。</Feedback>}
          <div className={styles.actions}>
            {writable && operation.status === "needs_confirmation" && (
              <Button
                className={styles.button}
                isDisabled={busy}
                onPress={() => void apply("confirm")}
              >
                {request?.kind === "move"
                  ? "确认移动"
                  : request?.kind === "delete"
                    ? "确认删除"
                    : "确认操作"}
              </Button>
            )}
            <Button
              className={styles.button}
              isDisabled={busy}
              onPress={() => void apply("cancel")}
            >
              取消操作
            </Button>
          </div>
        </section>
      )}
      {operation.commitId && (
        <OperationChanges
          operation={operation}
          canUndo={writable}
          busy={busy}
          undo={() => void apply("undo")}
        />
      )}
      {error && <Feedback tone="error">{error}</Feedback>}
    </>
  );
}

function OperationChanges({
  operation,
  canUndo,
  busy,
  undo,
}: {
  operation: AiOperation;
  canUndo: boolean;
  busy: boolean;
  undo: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState("");
  const diff = useQuery({
    queryKey: [...workspaceKeys.workspace(operation.workspaceId), "ai", operation.id, "diff", path],
    queryFn: ({ signal }) => api.getAiOperationDiff(operation.id, path, signal),
    enabled: Boolean(expanded && path),
    select: (result) => result.diff,
  });
  const result = operation.writeResult;
  const hasSourceAndTarget =
    !result &&
    operation.changes.some((change) => !change.revision) &&
    operation.changes.some((change) => !change.beforeRevision);
  return (
    <section className={styles.changeList} aria-label="操作回执">
      <Feedback>
        {result?.created
          ? result.updated
            ? `新建 ${result.created} 个文件，更新 ${result.updated} 个文件`
            : `新建 ${result.created} 个文件`
          : hasSourceAndTarget
            ? `已变更 ${operation.changes.length} 个路径`
            : `已修改 ${operation.changes.length} 个文件`}
      </Feedback>
      <small title={operation.commitId ?? undefined}>版本 {operation.commitId?.slice(0, 8)}</small>
      {result && !operation.undoCommitId ? (
        <ul aria-label="写入的文档">
          {result.documents.map((doc) => (
            <li key={doc.path}>
              <Link
                to="/workspaces/$workspaceId/documents/$documentId"
                params={{ workspaceId: operation.workspaceId, documentId: doc.documentId }}
              >
                {doc.path}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !result && (
          <ul aria-label="版本中的文件">
            {operation.changes.map((change) => (
              <li key={change.path}>
                {change.revision ? (change.beforeRevision ? "更新" : "新增") : "移除"} {change.path}
              </li>
            ))}
          </ul>
        )
      )}
      <div className={styles.actions}>
        <ToggleButton className={styles.button} isSelected={expanded} onChange={setExpanded}>
          查看改动
        </ToggleButton>
        {!operation.undoCommitId && canUndo && (
          <Button className={styles.button} loading={busy} onPress={undo}>
            撤销
          </Button>
        )}
      </div>
      {operation.undoCommitId && (
        <>
          <Feedback>已撤销并保存为新版本</Feedback>
          <small title={operation.undoCommitId}>
            恢复版本 {operation.undoCommitId.slice(0, 8)}
          </small>
        </>
      )}
      {expanded && (
        <section className={styles.changeList} aria-label="AI 改动">
          <ul>
            {operation.changes.map((file) => (
              <li key={file.path}>
                <ToggleButton
                  className={styles.button}
                  isSelected={path === file.path}
                  onChange={(selected) => setPath(selected ? file.path : "")}
                >
                  {file.path}
                </ToggleButton>
              </li>
            ))}
          </ul>
          {path && diff.isPending && <Feedback>正在读取差异…</Feedback>}
          {path && diff.isError && <Feedback tone="error">无法读取版本差异。</Feedback>}
          {diff.data && (
            <pre className={styles.diff} aria-label="版本差异">
              {diff.data}
            </pre>
          )}
        </section>
      )}
    </section>
  );
}
