import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AiContext, AiOperation, AiTask, DocumentSummary } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, Form, TextArea, TextField, ToggleButton } from "../../ui/primitives";
import { ContextUnavailable, explicitReferences, referenceContext } from "./aiContext";
import { followOperation, isActiveOperation } from "./operationEvents";
import styles from "./AiPanel.module.css";

type Turn = { prompt: string; operation: AiOperation };
type Connection = "connected" | "retrying" | "unavailable";
type Action = { kind: "confirm" | "undo"; operation: AiOperation };

const statuses: Partial<Record<AiOperation["status"], string>> = {
  queued: "正在等待执行器…",
  running: "正在处理…",
  failed: "AI 请求失败，请重试。",
  conflict: "服务器内容已更新，请检查版本后重新提交。",
  canceled: "此 AI 操作已取消。",
};

export function AiPanel({
  id,
  workspace,
  documentId,
  documents,
  writable,
  resolveContext,
}: {
  id?: string;
  workspace: string;
  documentId?: string;
  documents: readonly DocumentSummary[];
  writable: boolean;
  resolveContext?: () => Promise<AiContext[]>;
}) {
  const client = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [local, setLocal] = useState<Turn[]>([]);
  const history = useQuery({
    queryKey: [...workspaceKeys.workspace(workspace), "ai", "operations", documentId ?? null],
    queryFn: ({ signal }) => api.listAiOperations(workspace, documentId, signal),
    staleTime: 0,
  });
  const byId = new Map<string, Turn>();
  for (const operation of history.data ?? []) byId.set(operation.id, { operation, prompt: "" });
  for (const turn of local) byId.set(turn.operation.id, turn);
  const turns = Array.from(byId.values());
  const hasTurns = turns.length > 0;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [action, setAction] = useState<Action>();
  const [actionError, setActionError] = useState<{ id: string; message: string }>();
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const refreshedCommits = useRef(new Set<string>());
  const transcript = useRef<HTMLDivElement>(null);
  const tail = useRef(true);
  const references = explicitReferences(prompt, documents);
  const referenceError = references.missing.length
    ? `未找到引用 ${references.missing.map((path) => `@${path}`).join("、")}`
    : references.documents.length > 24
      ? "每次请求最多引用 24 份文件。"
      : "";
  const disabled =
    submitting ||
    turns.some(({ operation }) => isActiveOperation(operation) && !unavailable.has(operation.id));
  const markUnavailable = useCallback((id: string) => {
    setUnavailable((previous) => new Set(previous).add(id));
  }, []);

  useLayoutEffect(() => {
    const log = transcript.current;
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (tail.current) log.scrollTop = log.scrollHeight;
    });
    const content = log.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [hasTurns]);

  const refresh = useCallback(
    (...commitIds: (string | null)[]) => {
      const unseen = commitIds.filter((commitId): commitId is string =>
        Boolean(commitId && !refreshedCommits.current.has(commitId)),
      );
      if (unseen.length === 0) return;
      for (const commitId of unseen) refreshedCommits.current.add(commitId);
      void client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
    [client, workspace],
  );

  const update = useCallback(
    (operation: AiOperation) => {
      if (operation.workspaceId !== workspace || operation.documentId !== (documentId ?? null))
        return;
      setLocal((previous) =>
        previous.some((turn) => turn.operation.id === operation.id)
          ? previous.map((turn) =>
              turn.operation.id === operation.id ? { ...turn, operation } : turn,
            )
          : [...previous, { operation, prompt: "" }],
      );
      refresh(operation.commitId, operation.undoCommitId);
    },
    [documentId, refresh, workspace],
  );

  async function submit(mode: AiTask["mode"]) {
    const value = prompt.trim();
    if (!value || disabled || referenceError) return;
    if (new TextEncoder().encode(value).length > 16_384) {
      setSubmitError("提示词过长，请缩短后重试。");
      return;
    }
    setSubmitError("");
    setSubmitting(true);
    try {
      const context = references.documents.length
        ? referenceContext(references.documents)
        : await resolveContext?.();
      const operation = await api.createAiOperation({
        workspaceId: workspace,
        ...(documentId && { documentId }),
        mode,
        prompt: value,
        ...(context?.length && { context }),
      });
      tail.current = true;
      setLocal((previous) => [...previous, { prompt: value, operation }]);
      setPrompt("");
    } catch (error) {
      setSubmitError(
        error instanceof ContextUnavailable ? error.message : "无法提交 AI 请求，请重试。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function applyAction(next: Action) {
    const { operation, kind } = next;
    setAction(next);
    setActionError(undefined);
    try {
      if (kind === "confirm" && operation.confirmation) {
        update(await api.confirmAiOperation(operation.id, operation.confirmation.id));
      } else if (kind === "undo") {
        const receipt = await api.undoAiOperation(operation.id);
        update({ ...operation, undoCommitId: receipt.commitId });
      }
    } catch (error) {
      setActionError({
        id: operation.id,
        message:
          error instanceof ApiError && error.status === 409
            ? "文件版本已更新，请检查当前内容。"
            : kind === "confirm"
              ? "无法确认操作，请重试。"
              : "无法撤销操作，请重试。",
      });
      if (kind === "confirm") {
        try {
          update(await api.getAiOperation(operation.id));
        } catch {
          // Preserve the last known operation; the action error remains available.
        }
      }
    } finally {
      setAction(undefined);
    }
  }

  return (
    <section id={id} className={styles.panel} aria-label={documentId ? "文档 AI" : "Workspace AI"}>
      {!hasTurns && history.isError && <p role="alert">无法读取 AI 操作记录。</p>}
      {hasTurns && (
        <div
          className={styles.transcript}
          ref={transcript}
          onScroll={(event) => {
            const log = event.currentTarget;
            tail.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
          }}
        >
          <div className={styles.turns}>
            {turns.map(({ prompt: question, operation }) => (
              <div className={styles.turn} key={operation.id}>
                {question && <p className={styles.question}>{question}</p>}
                {isActiveOperation(operation) ? (
                  <OperationProgress
                    operation={operation}
                    update={update}
                    unavailable={markUnavailable}
                  />
                ) : statuses[operation.status] ? (
                  <p role="alert">{statuses[operation.status]}</p>
                ) : null}
                {operation.answer && <p className={styles.answer}>{operation.answer}</p>}
                {operation.sources.length > 0 && (
                  <ul className={styles.sources} aria-label="引用来源">
                    {operation.sources.map((source) => (
                      <li key={source.id}>
                        <Link
                          to="/workspaces/$workspaceId/documents/$documentId"
                          params={{ workspaceId: workspace, documentId: source.documentId }}
                          hash={source.blockId ?? ""}
                          title={source.revision}
                        >
                          {source.path}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                {operation.confirmation && (
                  <section className={styles.changeList} aria-label="待确认的操作">
                    <p>以下文件需要确认后才能更改。</p>
                    <ul>
                      {operation.confirmation.paths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                    {writable && (
                      <Button
                        className={styles.button}
                        isDisabled={Boolean(action)}
                        onPress={() => void applyAction({ kind: "confirm", operation })}
                      >
                        确认操作
                      </Button>
                    )}
                  </section>
                )}
                {operation.commitId && (
                  <OperationChanges
                    operation={operation}
                    canUndo={writable && !action}
                    undo={() => void applyAction({ kind: "undo", operation })}
                  />
                )}
                {actionError?.id === operation.id && <p role="alert">{actionError.message}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      <Form
        aria-label="AI 请求"
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit("chat");
        }}
      >
        <TextField aria-label="提示词" value={prompt} onChange={setPrompt} isDisabled={submitting}>
          <TextArea
            className={styles.prompt}
            placeholder="输入提示词，使用 @ 引用文件或目录"
            rows={2}
            maxLength={16_384}
          />
        </TextField>
        {references.documents.length > 0 && (
          <ul className={styles.references} aria-label="指定的上下文">
            {references.documents.slice(0, 24).map(({ id: document, path }) => (
              <li key={document}>@{path}</li>
            ))}
          </ul>
        )}
        {(referenceError || submitError) && <p role="alert">{referenceError || submitError}</p>}
        <div className={styles.actions}>
          <Button
            className={styles.button}
            type="submit"
            isDisabled={disabled || !prompt.trim() || Boolean(referenceError)}
          >
            询问
          </Button>
          {writable && (
            <Button
              className={styles.button}
              isDisabled={disabled || !prompt.trim() || Boolean(referenceError)}
              onPress={() => void submit("edit")}
            >
              修改
            </Button>
          )}
        </div>
      </Form>
    </section>
  );
}

function OperationProgress({
  operation,
  update,
  unavailable,
}: {
  operation: AiOperation;
  update: (operation: AiOperation) => void;
  unavailable: (id: string) => void;
}) {
  const { id, status } = operation;
  const [connection, setConnection] = useState<Connection>("connected");
  const [preview, setPreview] = useState("");
  const [progress, setProgress] = useState("");
  useEffect(
    () =>
      followOperation(
        id,
        (event) => {
          if (event.kind === "operation") {
            if (event.data.status === "running") {
              setPreview("");
              setProgress("");
            }
            update(event.data);
          } else if (event.kind === "progress") {
            setProgress(event.data.text);
          } else {
            setPreview((previous) => previous + event.data.text);
          }
        },
        (state) => {
          setConnection(state);
          if (state === "unavailable") unavailable(id);
        },
      ),
    [id, unavailable, update],
  );
  return (
    <>
      <output className={styles.status}>{progress || statuses[status]}</output>
      {connection !== "connected" && (
        <output className={styles.status}>
          {connection === "retrying" ? "连接中断，正在重新连接…" : "无法继续读取此操作。"}
        </output>
      )}
      {preview && <p className={styles.answer}>{preview}</p>}
    </>
  );
}

function OperationChanges({
  operation,
  canUndo,
  undo,
}: {
  operation: AiOperation;
  canUndo: boolean;
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
  return (
    <>
      <output>已修改 {operation.changes.length} 个文件</output>
      <div className={styles.actions}>
        <ToggleButton className={styles.button} isSelected={expanded} onChange={setExpanded}>
          查看改动
        </ToggleButton>
        {!operation.undoCommitId && (
          <Button className={styles.button} isDisabled={!canUndo} onPress={undo}>
            撤销
          </Button>
        )}
      </div>
      {operation.undoCommitId && <output>已撤销并保存为新版本</output>}
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
          {path && diff.isPending && <output>正在读取差异…</output>}
          {path && diff.isError && <p role="alert">无法读取版本差异。</p>}
          {diff.data && (
            <pre className={styles.diff} aria-label="版本差异">
              {diff.data}
            </pre>
          )}
        </section>
      )}
    </>
  );
}
