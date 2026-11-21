import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, aiAccessMessage, ApiError, cancelTurn, getAiSettings } from "../../api/client";
import type { AiContext, AiOperation, AiTask, DocumentSummary } from "../../api/client";
import { workspaceKeys, workspacesQuery } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Form, Select, TextAreaField } from "../../ui/Forms";
import { Feedback } from "../../ui/Feedback";
import type { CitationDraft } from "../document/citationHistory";
import { AiMaterials, MaterialCitation, useMaterialSelection } from "./AiMaterials";
import { AiOperationReceipt } from "./AiOperationReceipt";
import { canChangeGlobalReceipt } from "./receiptPermissions";
import { ConversationToolbar } from "./ConversationToolbar";
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
  standalone = false,
  global = false,
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
  standalone?: boolean;
  global?: boolean;
  active?: boolean;
  documents: readonly DocumentSummary[];
  writable: boolean;
  resolveContext?: () => Promise<AiContext[]>;
}) {
  const client = useQueryClient();
  const workspaces = useQuery({ ...workspacesQuery, enabled: global && active });
  const visibleSpaces = workspaces.isSuccess ? workspaces.data : [];
  const [prompt, setPromptState] = useState(
    () => citationDraft?.read() ?? returnVisit?.draft ?? "",
  );
  function setPrompt(value: string) {
    citationDraft?.update(value);
    setPromptState(value);
  }
  const [local, setLocal] = useState<Turn[]>([]);
  const chat = useAiConversation(workspace, documentId, active, returnVisit?.conversation, global);
  const [mode, setMode] = useState<AiTask["mode"]>(returnVisit?.mode ?? "chat");
  const sendMode = writable ? mode : "chat";
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
  // A saved conversation must finish its lookup before restoring its source link.
  const legacyHistory =
    !global &&
    !chat.accessDenied &&
    !chat.id &&
    (chat.selection === "recent" ||
      (!chat.selection &&
        chat.listing.isSuccess &&
        chat.listing.isFetchedAfterMount &&
        chat.conversations.length === 0));
  const history = useQuery({
    queryKey: [...workspaceKeys.workspace(workspace), "ai", "operations", documentId ?? null],
    queryFn: ({ signal }) => api.listAiOperations(workspace, documentId, signal),
    staleTime: 0,
    enabled: active && legacyHistory,
  });
  const byId = new Map<string, Turn>();
  if (legacyHistory && history.isSuccess) {
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
    if (global || turn.conversationId !== chat.id) continue;
    const server = byId.get(turn.operation.id);
    if (!server || !isActiveOperation(turn.operation) || isActiveOperation(server.operation)) {
      byId.set(turn.operation.id, {
        ...server,
        ...turn,
        prompt: turn.prompt || server?.prompt || "",
      });
    }
  }
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  const historyUnavailable =
    legacyHistory && history.isError && Boolean(aiAccessMessage(history.error));
  const authorizedTurns = chat.accessDenied || historyUnavailable ? [] : Array.from(byId.values());
  const turns = authorizedTurns.filter((turn) => !unavailable.has(turn.operation.id));
  const hiddenTurn = authorizedTurns.length !== turns.length;
  const conversations = hiddenTurn
    ? chat.conversations.map((c) =>
        c.id === chat.id ? { ...c, title: turns[0]?.prompt ?? null } : c,
      )
    : chat.conversations;
  const hasTurns = turns.length > 0;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const refreshedReceipts = useRef(new Set<string>());
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
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const element = panel.current;
    if (!standalone || !viewport || !element) return;
    function resize() {
      if (!element || !viewport) return;
      if (viewport.scale === 1 && viewport.height < window.innerHeight - 1) {
        const available =
          viewport.offsetTop + viewport.height - element.getBoundingClientRect().top;
        element.style.maxBlockSize = Math.max(0, available) + "px";
      } else {
        element.style.removeProperty("max-block-size");
      }
    }
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, [standalone]);
  const sourceLink = useRef<HTMLAnchorElement>(null);
  const restoredLink = useRef<AiTranscriptVisit>(undefined);
  const hasSource = turns.some(
    ({ operation }) =>
      operation.sources.some((source) => source.id === returnVisit?.sourceId) ||
      operation.writeResult?.documents.some(
        (doc) => `write-result:${operation.id}:${doc.documentId}` === returnVisit?.sourceId,
      ) ||
      ["transfer-source:", "transfer-result:", "management-result:"].some(
        (prefix) => prefix + operation.id === returnVisit?.sourceId,
      ),
  );
  useLayoutEffect(() => {
    if (!returnVisit) restoredLink.current = undefined;
    if (
      !active ||
      !returnVisit ||
      (returnVisit.sourceId && !hasSource) ||
      restoredLink.current === returnVisit
    )
      return;
    const log = transcript.current;
    const target = returnVisit.sourceId
      ? sourceLink.current
      : composer.current?.querySelector("textarea");
    if (!log || !target) return;
    const restore = () => {
      log.scrollTop = returnVisit.scrollTop;
      target.focus({ preventScroll: true });
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
  const references = explicitReferences(global ? "" : prompt, documents);
  const referenceError = references.missing.length
    ? `未找到引用 ${references.missing.map((path) => `@${path}`).join("、")}`
    : references.documents.length > 24
      ? "每次请求最多引用 24 份文件。"
      : "";
  const missingModel = config.data?.dispatchMode === "managed" && !config.data.effectiveSelection;
  const offline = config.data?.dispatchMode === "managed" && !config.data.runnerOnline;
  const legacyGlobal = global && config.data?.dispatchMode === "legacy";
  const pendingDecision = turns.some(({ operation }) => operation.status === "needs_confirmation");
  const disabled =
    pendingDecision ||
    chat.accessDenied ||
    legacyGlobal ||
    submitting ||
    materialsPending ||
    missingModel ||
    offline ||
    config.data?.globalEnabled === false ||
    turns.some(({ operation }) => isActiveOperation(operation));
  const refreshConversation = chat.refresh;
  const markUnavailable = useCallback(
    (id: string) => {
      setUnavailable((previous) => new Set(previous).add(id));
      refreshConversation();
    },
    [refreshConversation],
  );

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

  // Turn history can deliver a completed write before its event stream opens.
  useEffect(() => {
    let changed = false;
    for (const { operation } of turns) {
      const revision =
        operation.undoCommitId ??
        operation.commitId ??
        (operation.workspaceManagement || operation.transferResult ? operation.id : undefined);
      if (!revision) continue;
      const receipt = operation.id + ":" + revision;
      if (refreshedReceipts.current.has(receipt)) continue;
      refreshedReceipts.current.add(receipt);
      changed = true;
    }
    if (changed) {
      void client.invalidateQueries({
        queryKey: global ? workspaceKeys.all : workspaceKeys.workspace(workspace),
      });
    }
  }, [client, global, turns, workspace]);

  const updateOperation = chat.updateOperation;
  const update = useCallback(
    (operation: AiOperation) => {
      if (
        (global ? operation.scope !== "global" : operation.workspaceId !== workspace) ||
        operation.documentId !== (documentId ?? null)
      )
        return;
      if (!global)
        setLocal((previous) =>
          previous.some((turn) => turn.operation.id === operation.id)
            ? previous.map((turn) =>
                turn.operation.id === operation.id ? { ...turn, operation } : turn,
              )
            : [...previous, { operation, prompt: "", ...(chat.id && { conversationId: chat.id }) }],
        );
      updateOperation(operation);
    },
    [chat.id, documentId, global, updateOperation, workspace],
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
      if (!global)
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
              : (aiAccessMessage(error) ?? "无法提交 AI 请求，请重试。"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function captureVisit(sourceId?: string) {
    onSourceVisit?.({
      ...(sourceId && { sourceId }),
      scrollTop: transcript.current?.scrollTop ?? 0,
      draft: prompt,
      ...(standalone && { mode: sendMode }),
      ...(chat.username && {
        conversation: {
          username: chat.username,
          id: chat.id ?? (global || chat.selection === "new" ? "new" : "recent"),
          ...(chat.id &&
            selectedMaterials.length > 0 && {
              materialIds: [...selectedMaterials],
            }),
        },
      }),
      questions: new Map(
        (global ? [] : turns)
          .filter((turn) => turn.prompt)
          .map((turn) => [turn.operation.id, turn.prompt]),
      ),
    });
  }
  function pick(value: string) {
    chat.pick(value);
    setLocal([]);
    setSelectedMaterials([]);
    setDeleting(false);
    setPrompt("");
    setSubmitError("");
    setMode("chat");
    tail.current = true;
  }
  const sendControls = (
    <div className={styles.sendControls}>
      {writable ? (
        <Select
          className={styles.mode}
          label="发送模式"
          value={sendMode}
          entries={[
            { value: "chat", label: "询问" },
            { value: "edit", label: global ? "修改与管理" : "修改" },
          ]}
          onChange={setMode}
          disabled={submitting}
        />
      ) : (
        <span>询问</span>
      )}
      <Button
        type="submit"
        variant="primary"
        isDisabled={disabled || !prompt.trim() || Boolean(referenceError)}
      >
        发送
      </Button>
    </div>
  );
  const attachments = !chat.accessDenied && config.data?.dispatchMode === "managed" && (
    <AiMaterials
      conversationId={chat.id}
      ensureConversation={chat.ensureConversation}
      selected={selectedMaterials}
      onMaterialsChange={setSelectedMaterials}
      onPendingChange={setMaterialsPending}
      actions={standalone ? sendControls : undefined}
    />
  );
  return (
    <section
      id={id}
      ref={panel}
      data-standalone={standalone || undefined}
      className={styles.panel}
      data-document-ai={Boolean(documentId) || undefined}
      aria-label={documentId ? "文档 AI" : global ? "AI 助手对话" : "工作区 AI"}
    >
      {standalone ? (
        <ConversationToolbar
          global={global}
          spaces={visibleSpaces}
          conversations={conversations}
          selected={chat.id ?? (chat.selection === "recent" ? "recent" : undefined)}
          firstQuestion={turns[0]?.prompt ?? ""}
          saveScopeVisit={() => captureVisit()}
          busy={submitting || materialsPending}
          pick={pick}
          more={chat.listing.hasNextPage ? () => void chat.listing.fetchNextPage() : undefined}
          remove={async () => {
            await chat.remove();
            pick("new");
          }}
          focusPrompt={() => composer.current?.querySelector("textarea")?.focus()}
        />
      ) : (
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
              onChange={pick}
            />
          )}
          <Button className={styles.button} isDisabled={submitting} onPress={() => pick("new")}>
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
      )}
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
      {legacyGlobal && <Feedback>跨空间对话需要受管 AI。可在对话范围中选择单个空间继续。</Feedback>}
      {missingModel && <Feedback>当前没有可用模型，请联系管理员检查 AI 连接。</Feedback>}
      {!missingModel && offline && <Feedback>执行器离线，恢复连接后可以继续提问。</Feedback>}
      {!missingModel && config.data?.fallbackReason && (
        <Feedback>
          原模型或思考设置已失效，当前使用{config.data.effectiveSelection?.modelId ?? "可用设置"}。
        </Feedback>
      )}
      {chat.accessDenied && <Feedback tone="error">此会话已不可访问。</Feedback>}
      {hiddenTurn && <Feedback>部分对话内容已不可访问。</Feedback>}
      {!chat.accessDenied && (chat.turnsQuery.isError || chat.listing.isError) && (
        <Feedback tone="error">无法读取对话记录。</Feedback>
      )}
      {!hasTurns && history.isError && <Feedback tone="error">无法读取 AI 操作记录。</Feedback>}
      {(standalone || hasTurns) && (
        <div
          role={standalone ? "region" : undefined}
          aria-label={standalone ? "对话记录" : undefined}
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
                <div
                  className={styles.turn}
                  role={standalone ? "article" : undefined}
                  key={operation.id}
                >
                  {standalone && question && <p className={styles.question}>{question}</p>}
                  <div className={standalone ? styles.reply : undefined}>
                    {standalone && <span className={styles.speaker}>AI 助手</span>}
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
                    {!standalone && question && <p className={styles.question}>{question}</p>}
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
                    {turn.turnId &&
                      ["failed", "conflict", "canceled"].includes(operation.status) && (
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
                                params={{
                                  workspaceId: source.workspaceId ?? workspace,
                                  documentId: source.documentId,
                                }}
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
                                  captureVisit(source.id);
                                }}
                              >
                                {global && source.workspaceName && `${source.workspaceName} / `}
                                {source.path}
                              </Link>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <AiOperationReceipt
                      operation={operation}
                      writable={
                        global ? canChangeGlobalReceipt(operation, visibleSpaces) : writable
                      }
                      update={update}
                      onAccessDenied={markUnavailable}
                      onVisit={captureVisit}
                      returnLink={sourceLink}
                      returnLinkId={returnVisit?.sourceId}
                      afterCancel={() => composer.current?.querySelector("textarea")?.focus()}
                    />
                  </div>
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
          void submit(sendMode);
        }}
      >
        {!standalone && attachments}
        <div className={styles.composer} ref={composer}>
          <TextAreaField
            aria-label="提示词"
            value={prompt}
            onChange={setPrompt}
            disabled={submitting}
            inputClassName={styles.prompt}
            placeholder={
              global
                ? sendMode === "edit"
                  ? "想在哪个空间进行什么操作？"
                  : "向 AI 提问，可指定要查阅的空间"
                : "输入提示词，使用 @ 引用文件或目录"
            }
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
          {pendingDecision && <Feedback>请先确认或取消上方操作，再继续提问。</Feedback>}
          {(referenceError || submitError) && (
            <Feedback tone="error">{referenceError || submitError}</Feedback>
          )}
          {sendMode === "edit" && writable && (
            <p className={styles.modeHint} role="note">
              {global
                ? "修改与管理会直接执行文档或空间操作，并记录操作回执。"
                : "修改会直接写入正文，并生成可恢复的版本。"}
            </p>
          )}
          {standalone ? attachments || sendControls : sendControls}
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
          if (state === "unavailable") {
            setPreview("");
            setProgress("");
            unavailable(id);
          }
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
