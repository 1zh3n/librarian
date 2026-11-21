import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, cancelTurn, getAiSettings } from "../../api/client";
import type { AiContext, AiOperation, AiTask, DocumentSummary } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Form, Select, TextAreaField } from "../../ui/Forms";
import { Feedback } from "../../ui/Feedback";
import type { CitationDraft } from "../document/citationHistory";
import { AiMaterials, MaterialCitation, useMaterialSelection } from "./AiMaterials";
import { AiOperationReceipt } from "./AiOperationReceipt";
import { AiAnswer } from "./AiAnswer";
import { useAiConversation } from "./useAiConversation";
import { citationHash } from "../document/sourceVisit";
import type { AiTranscriptVisit } from "../document/sourceVisit";
import { ContextUnavailable, explicitReferences, referenceContext } from "./aiContext";
import { followOperation, isActiveOperation } from "./operationEvents";
import styles from "./AiPanel.module.css";

type Turn = {
  prompt: string;
  operation: AiOperation;
  conversationId?: string;
  turnId?: string;
  historyTruncated?: boolean;
};
type Connection = "connected" | "retrying" | "unavailable";

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
  active = true,
  documents,
  writable,
  resolveContext,
  returnVisit,
  citationDraft,
  onSourceVisit,
}: {
  citationDraft?: CitationDraft | undefined;
  returnVisit?: AiTranscriptVisit | undefined;
  onSourceVisit?: (visit: AiTranscriptVisit) => void;
  id?: string;
  workspace: string;
  documentId?: string;
  active?: boolean;
  documents: readonly DocumentSummary[];
  writable: boolean;
  resolveContext?: () => Promise<AiContext[]>;
}) {
  const client = useQueryClient();
  const [prompt, setPromptState] = useState(
    () => citationDraft?.read() ?? returnVisit?.draft ?? "",
  );
  function setPrompt(value: string) {
    citationDraft?.update(value);
    setPromptState(value);
  }
  const [local, setLocal] = useState<Turn[]>([]);
  const chat = useAiConversation(workspace, documentId, active, returnVisit?.conversation);
  const [deleting, setDeleting] = useState(false);
  const config = useQuery({
    queryKey: ["ai", "settings", chat.username],
    queryFn: ({ signal }) => getAiSettings(signal),
    enabled: active && Boolean(chat.username),
    staleTime: 15_000,
    refetchInterval: (query) =>
      active && query.state.data?.dispatchMode === "managed" ? 15_000 : false,
  });
  const {
    selected: selectedMaterials,
    setSelected: setSelectedMaterials,
    restoring,
  } = useMaterialSelection(
    chat.username,
    config.data?.dispatchMode === "legacy" ? undefined : chat.id,
    returnVisit?.conversation,
  );
  const [uploadPending, setMaterialsPending] = useState(false);
  const materialsPending = uploadPending || restoring;
  const history = useQuery({
    queryKey: [...workspaceKeys.workspace(workspace), "ai", "operations", documentId ?? null],
    queryFn: ({ signal }) => api.listAiOperations(workspace, documentId, signal),
    staleTime: 0,
    enabled: active && !chat.id && chat.selection !== "new",
  });
  const byId = new Map<string, Turn>();
  if (!chat.id && chat.selection !== "new") {
    for (const operation of history.data ?? [])
      byId.set(operation.id, { operation, prompt: returnVisit?.questions.get(operation.id) ?? "" });
  }
  for (const t of chat.allTurns)
    byId.set(t.operationId, {
      operation: t.operation,
      prompt: t.prompt,
      turnId: t.id,
      conversationId: t.conversationId,
      historyTruncated: t.historyTruncated,
    });
  for (const turn of local) {
    if (turn.conversationId !== chat.id) continue;
    const server = byId.get(turn.operation.id);
    if (!server || !isActiveOperation(turn.operation) || isActiveOperation(server.operation)) {
      byId.set(turn.operation.id, {
        ...server,
        ...turn,
        prompt: turn.prompt || server?.prompt || "",
      });
    }
  }
  const turns = Array.from(byId.values());
  const hasTurns = turns.length > 0;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const refreshedCommits = useRef(new Set<string>());
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    function revealComposer() {
      const group = composer.current;
      if (!group || (viewport?.width ?? window.innerWidth) > 800) return;
      const input = group.querySelector("textarea");
      if (!input || document.activeElement !== input) return;
      const controls = [input, group.querySelector("button:not([disabled])")].filter(
        (el): el is HTMLElement => el instanceof HTMLElement,
      );
      const obscured = controls.some((el) => {
        const bounds = el.getBoundingClientRect();
        return !el.contains(
          document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
        );
      });
      if (obscured) group.scrollIntoView({ block: "center", inline: "nearest" });
    }
    window.addEventListener("resize", revealComposer);
    viewport?.addEventListener("resize", revealComposer);
    return () => {
      window.removeEventListener("resize", revealComposer);
      viewport?.removeEventListener("resize", revealComposer);
    };
  }, []);
  const tail = useRef(!returnVisit);
  const sourceLink = useRef<HTMLAnchorElement>(null);
  const restoredLink = useRef<AiTranscriptVisit>(undefined);
  const hasSource = turns.some(({ operation }) =>
    operation.sources.some((source) => source.id === returnVisit?.sourceId),
  );
  useLayoutEffect(() => {
    if (!returnVisit) restoredLink.current = undefined;
    if (!active || !returnVisit || !hasSource || restoredLink.current === returnVisit) return;
    const log = transcript.current;
    if (!log || !sourceLink.current) return;
    const link = sourceLink.current;
    const restore = () => {
      log.scrollTop = returnVisit.scrollTop;
      link.focus({ preventScroll: true });
      if (Math.abs(log.scrollTop - returnVisit.scrollTop) <= 1) {
        restoredLink.current = returnVisit;
        observer.disconnect();
      }
    };
    const observer = new ResizeObserver(restore);
    if (log.firstElementChild) observer.observe(log.firstElementChild);
    const frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, returnVisit, hasSource]);
  const references = explicitReferences(prompt, documents);
  const referenceError = references.missing.length
    ? `未找到引用 ${references.missing.map((path) => `@${path}`).join("、")}`
    : references.documents.length > 24
      ? "每次请求最多引用 24 份文件。"
      : "";
  const missingModel = config.data?.dispatchMode === "managed" && !config.data.effectiveSelection;
  const offline = config.data?.dispatchMode === "managed" && !config.data.runnerOnline;
  const disabled =
    submitting ||
    materialsPending ||
    missingModel ||
    offline ||
    config.data?.globalEnabled === false ||
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

  const updateOperation = chat.updateOperation;
  const update = useCallback(
    (operation: AiOperation) => {
      if (operation.workspaceId !== workspace || operation.documentId !== (documentId ?? null))
        return;
      setLocal((previous) =>
        previous.some((turn) => turn.operation.id === operation.id)
          ? previous.map((turn) =>
              turn.operation.id === operation.id ? { ...turn, operation } : turn,
            )
          : [...previous, { operation, prompt: "", ...(chat.id && { conversationId: chat.id }) }],
      );
      updateOperation(operation);
      refresh(operation.commitId, operation.undoCommitId);
    },
    [chat.id, documentId, refresh, updateOperation, workspace],
  );

  async function submit(mode: AiTask["mode"], retry?: Turn) {
    const value = (retry?.prompt ?? prompt).trim();
    if (!value || disabled || (!retry && referenceError)) return;
    if (new TextEncoder().encode(value).length > 16_384) {
      setSubmitError("提示词过长，请缩短后重试。");
      return;
    }
    setSubmitError("");
    setSubmitting(true);
    try {
      const context = retry
        ? undefined
        : references.documents.length
          ? referenceContext(references.documents)
          : await resolveContext?.();
      const turn = await chat.send({
        mode,
        prompt: value,
        ...(context?.length && { context }),
        ...(retry?.turnId && { retryOfTurnId: retry.turnId }),
        ...(selectedMaterials.length && { materialIds: selectedMaterials }),
      });
      tail.current = true;
      setLocal((previous) => [
        ...previous,
        {
          prompt: value,
          operation: turn.operation,
          conversationId: turn.conversationId,
          turnId: turn.id,
          historyTruncated: turn.historyTruncated,
        },
      ]);
      if (!retry) setPrompt("");
    } catch (error) {
      setSubmitError(
        error instanceof ContextUnavailable
          ? error.message
          : error instanceof ApiError && error.code === "runner_offline"
            ? "执行器离线，恢复连接后请重试。"
            : error instanceof ApiError && error.code === "managed_activation_required"
              ? "请先启用受管 AI，再发送参考材料。"
              : "无法提交 AI 请求，请重试。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      id={id}
      className={styles.panel}
      data-document-ai={Boolean(documentId) || undefined}
      aria-label={documentId ? "文档 AI" : "工作区 AI"}
    >
      <div className={styles.actions}>
        {chat.conversations.length > 0 && (
          <Select
            label="会话"
            value={chat.id ?? (chat.selection === "new" ? "new" : "recent")}
            entries={[
              ...chat.conversations.map((c) => ({
                value: c.id,
                label: new Date(c.createdAt).toLocaleString(),
              })),
              { value: "recent", label: "最近操作" },
              ...(chat.selection === "new" ? [{ value: "new", label: "新对话" }] : []),
            ]}
            onChange={(value) => {
              chat.pick(value);
              setLocal([]);
              setSelectedMaterials([]);
              setDeleting(false);
              setPrompt("");
            }}
          />
        )}
        <Button
          className={styles.button}
          isDisabled={submitting}
          onPress={() => {
            chat.pick("new");
            setLocal([]);
            setSelectedMaterials([]);
            setDeleting(false);
            setPrompt("");
          }}
        >
          新对话
        </Button>
        {chat.id && (
          <Button className={styles.button} onPress={() => setDeleting(true)}>
            删除会话
          </Button>
        )}
        {chat.listing.hasNextPage && (
          <Button className={styles.button} onPress={() => void chat.listing.fetchNextPage()}>
            更多会话
          </Button>
        )}
      </div>
      {deleting && (
        <fieldset aria-label="删除会话">
          <p>删除本次对话和材料？已保存的文档版本仍可在历史中查看。</p>
          <Button className={styles.button} onPress={() => setDeleting(false)}>
            取消
          </Button>
          <Button
            className={styles.button}
            onPress={() =>
              void chat.remove().then(
                () => {
                  setLocal([]);
                  setPrompt("");
                  setSelectedMaterials([]);
                  setDeleting(false);
                },
                () => setSubmitError("删除会话失败，请重试。"),
              )
            }
          >
            确认删除会话
          </Button>
        </fieldset>
      )}
      {config.data?.globalEnabled === false && <Feedback>管理员已停用 AI。</Feedback>}
      {missingModel && <Feedback>当前没有可用模型，请联系管理员检查 AI 连接。</Feedback>}
      {!missingModel && offline && <Feedback>执行器离线，恢复连接后可以继续提问。</Feedback>}
      {!missingModel && config.data?.fallbackReason && (
        <Feedback>
          原模型或思考设置已失效，当前使用{config.data.effectiveSelection?.modelId ?? "可用设置"}。
        </Feedback>
      )}
      {chat.turnsQuery.isError && <Feedback tone="error">无法读取对话记录。</Feedback>}
      {!hasTurns && history.isError && <Feedback tone="error">无法读取 AI 操作记录。</Feedback>}
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
            {turns.map((turn) => {
              const { prompt: question, operation } = turn;
              return (
                <div className={styles.turn} key={operation.id}>
                  {operation.selection && (
                    <small>
                      {operation.selection.modelId} ·{" "}
                      {operation.selection.thinking.mode === "effort"
                        ? operation.selection.thinking.level
                        : operation.selection.thinking.mode === "off"
                          ? "关闭思考"
                          : "供应商默认"}
                    </small>
                  )}
                  {question && <p className={styles.question}>{question}</p>}
                  {isActiveOperation(operation) ? (
                    <OperationProgress
                      operation={operation}
                      update={update}
                      unavailable={markUnavailable}
                    />
                  ) : statuses[operation.status] ? (
                    <Feedback tone="error">{statuses[operation.status]}</Feedback>
                  ) : null}
                  {turn.historyTruncated && <Feedback>较早的对话已超出本轮上下文范围。</Feedback>}
                  {turn.turnId && chat.id && isActiveOperation(operation) && (
                    <Button
                      className={styles.button}
                      onPress={() =>
                        void cancelTurn(chat.id!, turn.turnId!).then(
                          (t) => {
                            update(t.operation);
                            chat.refresh();
                          },
                          () => setSubmitError("停止失败，请重试。"),
                        )
                      }
                    >
                      停止
                    </Button>
                  )}
                  {turn.turnId && ["failed", "conflict", "canceled"].includes(operation.status) && (
                    <Button
                      className={styles.button}
                      isDisabled={disabled}
                      onPress={() => void submit(operation.mode, turn)}
                    >
                      重试本轮
                    </Button>
                  )}
                  {operation.answer && <AiAnswer id={operation.id} answer={operation.answer} />}
                  {operation.sources.length > 0 && (
                    <ul className={styles.sources} aria-label="引用来源">
                      {operation.sources.map((source) => (
                        <li key={source.id}>
                          {"kind" in source ? (
                            <MaterialCitation
                              conversationId={chat.id ?? source.conversationId}
                              source={source}
                            />
                          ) : (
                            <Link
                              to="/workspaces/$workspaceId/documents/$documentId"
                              params={{ workspaceId: workspace, documentId: source.documentId }}
                              hash={citationHash(source)}
                              state={(origin) => ({
                                readerCitation: source.id,
                                readerCitationOrigin: origin.__TSR_key,
                              })}
                              hashScrollIntoView={false}
                              title={source.revision}
                              ref={returnVisit?.sourceId === source.id ? sourceLink : undefined}
                              onClick={(event) => {
                                if (
                                  event.defaultPrevented ||
                                  event.button !== 0 ||
                                  event.ctrlKey ||
                                  event.metaKey ||
                                  event.altKey ||
                                  event.shiftKey
                                )
                                  return;
                                onSourceVisit?.({
                                  sourceId: source.id,
                                  scrollTop: transcript.current?.scrollTop ?? 0,
                                  draft: prompt,
                                  ...(chat.username && {
                                    conversation: {
                                      username: chat.username,
                                      id: chat.id ?? "recent",
                                      ...(chat.id &&
                                        selectedMaterials.length > 0 && {
                                          materialIds: [...selectedMaterials],
                                        }),
                                    },
                                  }),
                                  questions: new Map(
                                    turns
                                      .filter((turn) => turn.prompt)
                                      .map((turn) => [turn.operation.id, turn.prompt]),
                                  ),
                                });
                              }}
                            >
                              {source.path}
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <AiOperationReceipt
                    operation={operation}
                    writable={writable}
                    update={update}
                    afterCancel={() => composer.current?.querySelector("textarea")?.focus()}
                  />
                </div>
              );
            })}
            {chat.turnsQuery.hasNextPage && (
              <Button
                className={styles.button}
                onPress={() => void chat.turnsQuery.fetchNextPage()}
              >
                更多轮次
              </Button>
            )}
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
        {config.data?.dispatchMode === "managed" && (
          <AiMaterials
            conversationId={chat.id}
            ensureConversation={chat.ensureConversation}
            selected={selectedMaterials}
            onMaterialsChange={setSelectedMaterials}
            onPendingChange={setMaterialsPending}
          />
        )}
        <div className={styles.composer} ref={composer}>
          <TextAreaField
            aria-label="提示词"
            value={prompt}
            onChange={setPrompt}
            disabled={submitting}
            inputClassName={styles.prompt}
            placeholder="输入提示词，使用 @ 引用文件或目录"
            rows={2}
            maxLength={16_384}
          />
          {references.documents.length > 0 && (
            <ul className={styles.references} aria-label="指定的上下文">
              {references.documents.slice(0, 24).map(({ id: document, path }) => (
                <li key={document}>@{path}</li>
              ))}
            </ul>
          )}
          {(referenceError || submitError) && (
            <Feedback tone="error">{referenceError || submitError}</Feedback>
          )}
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
      <Feedback className={styles.status}>{progress || statuses[status]}</Feedback>
      {connection !== "connected" && (
        <Feedback className={styles.status}>
          {connection === "retrying" ? "连接中断，正在重新连接…" : "无法继续读取此操作。"}
        </Feedback>
      )}
      {preview && <p className={styles.answer}>{preview}</p>}
    </>
  );
}
