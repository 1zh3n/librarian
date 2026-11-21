import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { aiAccessMessage, api, ApiError } from "../../api/client";
import type { AiOperation } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, ToggleButton } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { accessMessage, actionError } from "../navigation/fileActions";
import styles from "./AiPanel.module.css";

type Decision = "confirm" | "cancel" | "undo";

export function AiOperationReceipt({
  operation,
  writable,
  update,
  afterCancel,
  onVisit,
  onAccessDenied,
  returnLink,
  returnLinkId,
}: {
  operation: AiOperation;
  writable: boolean;
  update: (operation: AiOperation) => void;
  afterCancel: () => void;
  onAccessDenied?: ((id: string) => void) | undefined;
  onVisit?: ((id: string) => void) | undefined;
  returnLink?: RefObject<HTMLAnchorElement | null> | undefined;
  returnLinkId?: string | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hiddenOperation, setHiddenOperation] = useState<string>();
  const confirmation = operation.confirmation;
  const plan = confirmation?.plan;
  const request = plan?.request;
  const transfer = confirmation?.transfer;
  const receipt = operation.transferResult;
  const management = operation.workspaceManagement;
  const focusReceipt = useRef(false);
  const receiptLink = useRef<HTMLAnchorElement>(null);
  useLayoutEffect(() => {
    if (receipt && focusReceipt.current) {
      receiptLink.current?.focus();
      focusReceipt.current = false;
    }
  }, [receipt]);
  function visitLink(kind: string, documentId?: string) {
    const id = [kind, operation.id, documentId].filter(Boolean).join(":");
    return {
      state: (origin: { __TSR_key?: string | undefined }) => ({
        readerCitation: id,
        readerCitationOrigin: origin.__TSR_key,
      }),
      ref: returnLinkId === id ? returnLink : kind === "transfer-result" ? receiptLink : undefined,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.button === 0 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.defaultPrevented
        )
          onVisit?.(id);
      },
    };
  }
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
        focusReceipt.current = kind === "confirm" && Boolean(updated.transferResult);
        update(updated);
        if (kind === "cancel") afterCancel();
      }
    } catch (cause) {
      const accessError = aiAccessMessage(cause);
      if (accessError) {
        setError(accessError);
      } else if (transfer && kind === "confirm") {
        setError(actionError(cause));
      } else if (cause instanceof ApiError && cause.status === 409) {
        setError("文件版本已更新，请检查当前内容。");
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
      } catch (refreshError) {
        const denied = aiAccessMessage(refreshError);
        if (denied) {
          setHiddenOperation(operation.id);
          onAccessDenied?.(operation.id);
          setError(denied);
        }
      }
    } finally {
      setBusy(false);
    }
  }
  if (hiddenOperation === operation.id) return <Feedback tone="error">{error}</Feedback>;
  return (
    <>
      {confirmation && (
        <section className={styles.changeList} aria-label="待确认的操作">
          {transfer ? (
            <>
              <p>
                {transfer.kind === "move" ? "移动" : "复制"}
                {transfer.sourceKind === "folder" ? "文件夹" : "文档"} · {transfer.fileCount} 个文件
              </p>
              <p>
                来源　
                {transfer.documentId ? (
                  <Link
                    to="/workspaces/$workspaceId/documents/$documentId"
                    params={{
                      workspaceId: transfer.sourceWorkspaceId,
                      documentId: transfer.documentId,
                    }}
                    {...visitLink("transfer-source")}
                  >
                    {transfer.sourceWorkspaceName} / {transfer.sourcePath}
                  </Link>
                ) : (
                  <span>
                    {transfer.sourceWorkspaceName} / {transfer.sourcePath}
                  </span>
                )}
              </p>
              <p>
                目标　
                <strong>
                  {transfer.targetWorkspaceName} / {transfer.targetPath}
                </strong>
              </p>
              <Feedback>
                {accessMessage(transfer.kind, transfer.access) ?? "两个空间的成员访问权限相同。"}
              </Feedback>
            </>
          ) : request?.kind === "move" ? (
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
          {!transfer && (
            <ul aria-label="受影响的路径">
              {confirmation.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
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
                {transfer?.kind === "copy"
                  ? "确认复制"
                  : transfer?.kind === "move" || request?.kind === "move"
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
      {receipt && (
        <section className={styles.changeList} aria-label="操作回执">
          <p>
            {receipt.kind === "move" ? "已移动到" : "已复制到"}　
            {receipt.documentId ? (
              <Link
                to="/workspaces/$workspaceId/documents/$documentId"
                params={{ workspaceId: receipt.workspaceId, documentId: receipt.documentId }}
                {...visitLink("transfer-result")}
              >
                {receipt.workspaceName} / {receipt.path}
              </Link>
            ) : (
              <>
                <Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId: receipt.workspaceId }}
                  {...visitLink("transfer-result")}
                >
                  {receipt.workspaceName}
                </Link>{" "}
                / {receipt.path}
              </>
            )}
          </p>
        </section>
      )}
      {management && (
        <section className={styles.changeList} aria-label="操作回执">
          <p>
            {managementSummary(management)}　
            <Link
              to="/workspaces/$workspaceId"
              params={{ workspaceId: management.workspaceId }}
              {...visitLink("management-result")}
            >
              {management.name}
            </Link>
          </p>
        </section>
      )}
      {operation.commitId && (
        <OperationChanges
          operation={operation}
          canUndo={writable}
          busy={busy}
          renderDocumentLink={(workspaceId, doc) => (
            <Link
              to="/workspaces/$workspaceId/documents/$documentId"
              params={{ workspaceId, documentId: doc.documentId }}
              {...visitLink("write-result", doc.documentId)}
            >
              {doc.path}
            </Link>
          )}
          undo={() => void apply("undo")}
        />
      )}
      {error && <Feedback tone="error">{error}</Feedback>}
    </>
  );
}

function managementSummary(result: NonNullable<AiOperation["workspaceManagement"]>) {
  switch (result.kind) {
    case "create_workspace":
      return "已创建空间";
    case "rename_workspace":
      return "空间已改名为";
    case "set_workspace_member":
      return `已将 ${result.username} 的权限设为${result.role === "write" ? "读写" : "只读"}`;
    case "remove_workspace_member":
      return `已移除成员 ${result.username}`;
  }
}

function OperationChanges({
  operation,
  canUndo,
  renderDocumentLink,
  busy,
  undo,
}: {
  operation: AiOperation;
  canUndo: boolean;
  renderDocumentLink: (
    workspaceId: string,
    doc: NonNullable<AiOperation["writeResult"]>["documents"][number],
  ) => ReactNode;
  busy: boolean;
  undo: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [path, setPath] = useState("");
  const workspace = operation.targetWorkspaceId ?? operation.workspaceId;
  const diff = useQuery({
    queryKey: [...workspaceKeys.workspace(workspace ?? ""), "ai", operation.id, "diff", path],
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
      {result && workspace && !operation.undoCommitId ? (
        <ul aria-label="写入的文档">
          {result.documents.map((doc) => (
            <li key={doc.path}>{renderDocumentLink(workspace, doc)}</li>
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
