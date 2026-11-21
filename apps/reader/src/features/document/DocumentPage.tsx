import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Button,
  Group,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  ToggleButton,
} from "../../ui/primitives";
import { api, ApiError } from "../../api/client";
import type { AiContext, DocumentSnapshot, OutlineSnapshot } from "../../api/client";
import { documentQuery, documentsQuery, outlineQuery, workspaceKeys } from "../../api/queries";
import { captureReaderAnchor, restoreReaderAnchor } from "../../markdown/anchors";
import type { AnchorPlacement } from "../../markdown/anchors";
import { analyzeMarkdown } from "../../markdown/analyze";
import { reanalyzeMarkdown } from "../../markdown/reanalyze";
import { relativeDocumentPath } from "../../markdown/relativePath";
import { ReaderSurface } from "../../markdown/ReaderSurface";
import { AiPanel } from "../ai/AiPanel";
import { ContextUnavailable } from "../ai/aiContext";
import { readerSelection } from "../ai/readerSelection";
import { contextSelection } from "../reading/contextSelection";
import { isEditingTarget, useReaderLayout } from "../reading/readingFocus";
import {
  isRepeatedSemanticBlock,
  semanticBlocks,
  showSemanticBlock,
  visibleSemanticBlock,
} from "../reading/semanticFocus";
import { VersionPanel } from "../revisions/VersionPanel";
import { openMarkdownSession } from "./documentSession";
import { DocumentReferencesPanel } from "./DocumentReferencesPanel";
import { MetadataPanel } from "./MetadataPanel";
import { OutlineCanvas } from "./OutlineCanvas";
import type { OutlineSession } from "./OutlineCanvas";
import type { MarkdownWrite } from "./saveController";
import { SaveNotice } from "./SaveNotice";
import styles from "./DocumentPage.module.css";

type Mode = "read" | "preview" | "source";
type Tool = "contents" | "outline" | "metadata" | "history" | "ai" | "references";

export function DocumentPage({
  workspace,
  document,
  writable,
}: {
  workspace: string;
  document: string;
  writable: boolean;
}) {
  const result = useQuery(documentQuery(workspace, document));
  if (!result.data) {
    if (result.isError) {
      const missing = result.error instanceof ApiError && result.error.status === 404;
      return (
        <p role="alert" className={styles.message}>
          {missing ? "此文档不存在" : "无法读取文档"}
        </p>
      );
    }
    return <output className={styles.message}>正在打开文档…</output>;
  }

  return <DocumentWorkspace workspace={workspace} snapshot={result.data} writable={writable} />;
}

function DocumentWorkspace({
  workspace,
  snapshot,
  writable,
}: {
  workspace: string;
  snapshot: DocumentSnapshot;
  writable: boolean;
}) {
  const { id: documentId, title } = snapshot.document;
  const { focus, preferences, createdDocument, clearCreatedDocument, navigationCancelled } =
    useReaderLayout();
  const navigate = useNavigate();
  const documents = useQuery(documentsQuery(workspace)).data;
  const path = snapshot.document.path;
  const resolveLink = useCallback(
    (href: string) => {
      const relative = relativeDocumentPath(path, href);
      const target = documents?.find((document) => document.path === relative?.path);
      if (!target || !relative) return;
      return {
        href: `/workspaces/${workspace}/documents/${target.id}${relative.hash}`,
        open: () =>
          void navigate({
            to: "/workspaces/$workspaceId/documents/$documentId",
            params: { workspaceId: workspace, documentId: target.id },
            hash: relative.hash.slice(1),
          }),
      };
    },
    [documents, navigate, path, workspace],
  );
  const resolveImage = useCallback(
    (src: string) => {
      const relative = relativeDocumentPath(path, src);
      if (relative && /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(relative.path)) {
        return api.workspaceAsset(workspace, relative.path);
      }
    },
    [path, workspace],
  );
  const queryClient = useQueryClient();
  const bodyKey = workspaceKeys.document(workspace, documentId);

  function setDocumentSnapshot(saved: DocumentSnapshot) {
    void queryClient.cancelQueries(
      { queryKey: bodyKey, exact: true },
      { revert: false, silent: true },
    );
    queryClient.setQueryData(bodyKey, saved);
    queryClient.setQueryData(
      workspaceKeys.documents(workspace),
      (documents: DocumentSnapshot["document"][] | undefined) =>
        documents?.map((document) => (document.id === documentId ? saved.document : document)),
    );
    void queryClient.invalidateQueries({
      queryKey: workspaceKeys.history(workspace, documentId),
      exact: true,
    });
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.references(workspace) });
  }

  const [body] = useState(() =>
    openMarkdownSession({
      initial: snapshot,
      readOnly: !writable,
      ariaLabel: "Markdown 正文",
      write: async ({ markdown, baseRevision }) => {
        if (baseRevision === null) throw new Error("正文缺少保存版本");
        await queryClient.cancelQueries({ queryKey: bodyKey, exact: true });
        return api.saveDocument(documentId, { markdown, baseRevision });
      },
      confirmed: setDocumentSnapshot,
      readCurrent: () => api.getDocument(documentId),
    }),
  );
  const [reading, setReading] = useState(() => ({
    source: snapshot.markdown,
    analysis: analyzeMarkdown(snapshot.markdown, documentId),
  }));
  const analysis = reading.analysis;
  const [mode, setMode] = useState<Mode>("read");
  const modeRef = useRef<Mode>("read");
  const [normalTool, setNormalTool] = useState<{
    layout: typeof preferences.layout;
    tool: Tool | undefined;
  }>();
  const [focusTool, setFocusTool] = useState<{ activation: number; tool: Tool | undefined }>();
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [outlineRequested, setOutlineRequested] = useState(false);
  const [outlineSession, setOutlineSession] = useState<OutlineSession>();
  const outlineEnabled = outlineRequested || snapshot.document.outlineEnabled;
  const defaultTool =
    preferences.layout === "review"
      ? "history"
      : preferences.layout === "research"
        ? "contents"
        : preferences.layout === "writing" && outlineEnabled
          ? "outline"
          : undefined;
  const tool = focus.active
    ? focusTool?.activation === focus.activation
      ? focusTool?.tool
      : undefined
    : normalTool?.layout === preferences.layout
      ? normalTool.tool
      : defaultTool;
  const toolAnchor = useRef<ReturnType<typeof captureReaderAnchor>>(undefined);
  const toolPane = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const inlineVisit = useRef<{
    anchor: ReturnType<typeof captureReaderAnchor>;
    source: string;
    scrollTop: number;
    opener: HTMLElement | undefined;
  }>(undefined);
  const moveToTool = useRef(false);
  const returnFromTool = useRef(false);
  const chooseTool = useCallback(
    (next: Tool | undefined) => {
      if (focus.activation !== undefined)
        setFocusTool({ activation: focus.activation, tool: next });
      else setNormalTool({ layout: preferences.layout, tool: next });
    },
    [focus.activation, preferences.layout],
  );
  function setTool(next: Tool | undefined) {
    const viewport = canvas.current?.closest("main");
    toolAnchor.current =
      viewport && modeRef.current === "read"
        ? captureReaderAnchor(viewport, analysis.blocks)
        : undefined;
    returnFromTool.current = !next;
    if (next && viewport && toolPane.current) {
      const inline =
        getComputedStyle(toolPane.current).getPropertyValue("--inline-tool").trim() === "1";
      if (inline) {
        const active = window.document.activeElement;
        inlineVisit.current ??= {
          anchor: toolAnchor.current,
          source: reading.source,
          scrollTop: viewport.scrollTop,
          opener:
            active instanceof HTMLElement && toolbar.current?.contains(active) ? active : undefined,
        };
        moveToTool.current = true;
      }
    }
    chooseTool(next);
  }
  const outline = useQuery({ ...outlineQuery(workspace, documentId), enabled: outlineEnabled });
  const canvas = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<{ source: string; range: Range } | undefined>(undefined);
  const [aiOpened, setAiOpened] = useState(false);
  const aiPanelId = `document-ai-${documentId}`;
  const pendingAnchor = useRef<AnchorPlacement | undefined>(undefined);
  const restoringEditor = useRef(false);

  useEffect(() => {
    if (body.sync(snapshot) && modeRef.current === "read") {
      const source = body.editor.source();
      setReading((previous) => ({
        source,
        analysis: reanalyzeMarkdown(source, documentId, previous),
      }));
    }
  }, [body, documentId, snapshot]);
  useEffect(() => () => body.saves.cancelScheduledSave(), [body]);

  useLayoutEffect(() => {
    const bar = toolbar.current;
    const page = bar?.parentElement;
    if (!bar || !page) return;
    const update = () =>
      page.style.setProperty("--document-toolbar-height", `${bar.offsetHeight}px`);
    const observer = new ResizeObserver(update);
    update();
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = canvas.current?.closest("main");
    const anchor = toolAnchor.current;
    toolAnchor.current = undefined;
    if (!viewport) return;
    const pane = toolPane.current;
    if (tool && pane && moveToTool.current) {
      moveToTool.current = false;
      const top = pane.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      const inset = (toolbar.current?.offsetHeight ?? 0) + 8;
      if (top < inset || top + Math.min(pane.offsetHeight, 88) > viewport.clientHeight) {
        viewport.scrollTop += top - inset;
      }
      pane.focus({ preventScroll: true });
      return;
    }
    if (!tool && inlineVisit.current && returnFromTool.current) {
      const visit = inlineVisit.current;
      inlineVisit.current = undefined;
      returnFromTool.current = false;
      visit.opener?.focus({ preventScroll: true });
      if (visit.anchor && modeRef.current === "read") {
        return restoreReaderAnchor(
          viewport,
          analysis.blocks,
          visit.anchor,
          visit.source === reading.source,
        );
      }
      viewport.scrollTop = visit.scrollTop;
      return;
    }
    if (anchor && modeRef.current === "read") {
      return restoreReaderAnchor(viewport, analysis.blocks, anchor, true);
    }
  }, [tool, analysis.blocks, reading.source]);

  useEffect(() => {
    const pane = toolPane.current;
    function closeInlineTool(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Escape" ||
        !inlineVisit.current
      )
        return;
      event.preventDefault();
      returnFromTool.current = true;
      chooseTool(undefined);
    }
    pane?.addEventListener("keydown", closeInlineTool);
    return () => pane?.removeEventListener("keydown", closeInlineTool);
  }, [chooseTool]);

  const rememberReadingSelection = useCallback(() => {
    const selection = window.getSelection();
    const surface = canvas.current;
    if (!surface || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (surface.contains(range.startContainer) && surface.contains(range.endContainer)) {
      savedSelection.current = range.collapsed ? undefined : { source: reading.source, range };
    }
  }, [reading.source]);

  useEffect(() => {
    if (mode !== "read") return;
    window.document.addEventListener("selectionchange", rememberReadingSelection);
    return () => window.document.removeEventListener("selectionchange", rememberReadingSelection);
  }, [mode, rememberReadingSelection]);

  const semantic = useMemo(() => semanticBlocks(analysis.blocks), [analysis.blocks]);
  const semanticIndex = semantic.findIndex((block) => block.id === focus.semanticBlock);
  const selectedBlock = semantic[semanticIndex];
  const setSemanticBlock = focus.setSemanticBlock;
  const semanticId = focus.semanticBlock;
  const previousSemantic = useRef<{ id: string; source: string; repeated: boolean } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const prior = previousSemantic.current;
    const repeated = semanticId ? isRepeatedSemanticBlock(semanticId, semantic) : false;
    previousSemantic.current = semanticId
      ? { id: semanticId, source: reading.source, repeated }
      : undefined;
    if (!semanticId) return;
    const ambiguous =
      prior?.id === semanticId && prior.source !== reading.source && (prior.repeated || repeated);
    if (!selectedBlock || ambiguous) setSemanticBlock(undefined);
  }, [reading.source, selectedBlock, semantic, semanticId, setSemanticBlock]);

  function moveSemantic(direction: -1 | 0 | 1) {
    const root = canvas.current;
    if (!root) return;
    const block =
      semanticIndex < 0
        ? visibleSemanticBlock(root, semantic)
        : semantic[semanticIndex + direction];
    if (!block) return;
    savedSelection.current = undefined;
    setSemanticBlock(block.id);
    showSemanticBlock(root, block);
  }

  function readerShortcut(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isEditingTarget(event.target)
    )
      return;
    const key = event.key.toLowerCase();
    if (key && key === preferences.focusKey) {
      event.preventDefault();
      focus.toggle();
    } else if (key === "[" || key === "]") {
      event.preventDefault();
      moveSemantic(key === "[" ? -1 : 1);
    }
  }

  const isDirty = useCallback(
    () =>
      body.editor.isComposing() ||
      body.saves.isDirty() ||
      Boolean(outlineSession?.editor.isComposing() || outlineSession?.saves.isDirty()),
    [body, outlineSession],
  );
  const flush = useCallback(async () => {
    await Promise.all([
      body.editor.isComposing() ? undefined : body.saves.flush(),
      !outlineSession || outlineSession.editor.isComposing()
        ? undefined
        : outlineSession.saves.flush(),
    ]);
  }, [body, outlineSession]);
  async function resolveAiContext(): Promise<AiContext[]> {
    const confirmed = body.saves.confirmed();
    const source = mode === "read" ? reading.source : body.editor.source();
    const root = canvas.current;
    const stored = savedSelection.current;
    const editor = mode === "read" ? undefined : body.editor.selection();
    const range = editor
      ? { from: Math.min(editor.anchor, editor.head), to: Math.max(editor.anchor, editor.head) }
      : root && stored?.source === source
        ? readerSelection(root, stored.range, source, analysis)
        : undefined;
    const local =
      range && range.from < range.to
        ? range
        : source === reading.source && selectedBlock
          ? { from: selectedBlock.from, to: selectedBlock.to, blockId: selectedBlock.id }
          : undefined;
    if (!local) return [{ documentId }];
    if (local.to - local.from > 65_536) {
      throw new ContextUnavailable("所选范围过长，请缩小范围后重试。");
    }
    if (source !== confirmed.markdown) {
      if (body.editor.isComposing()) {
        throw new ContextUnavailable("请先完成正在输入的正文。");
      }
      await body.saves.flush();
      if (source !== body.saves.confirmed().markdown) {
        throw new ContextUnavailable("请先保存选中的正文，再提交 AI 请求。");
      }
    }
    return [{ documentId, revision: body.saves.confirmed().revision, ...local }];
  }

  useBlocker({
    enableBeforeUnload: isDirty,
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname || !isDirty()) return false;
      await flush();
      const blocked = isDirty() && !window.confirm("还有未保存的内容。确定离开文档？");
      if (blocked) navigationCancelled(next.pathname);
      return blocked;
    },
  });

  const writeOutline = async (draft: MarkdownWrite) => {
    await queryClient.cancelQueries({
      queryKey: workspaceKeys.outline(workspace, documentId),
      exact: true,
    });
    return api.saveOutline(documentId, draft);
  };
  function confirmOutline(saved: OutlineSnapshot) {
    const key = workspaceKeys.outline(workspace, documentId);
    void queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: false, silent: true });
    queryClient.setQueryData(key, saved);
    queryClient.setQueryData<DocumentSnapshot>(bodyKey, (previous) =>
      previous
        ? { ...previous, document: { ...previous.document, outlineEnabled: true } }
        : previous,
    );
  }

  const enterEditor = useCallback(
    (next: "preview" | "source", position?: number) => {
      if (!writable || restoringVersion || body.editor.isComposing()) return;
      if (mode === "read") {
        const viewport = canvas.current?.closest("main");
        const anchor = viewport ? captureReaderAnchor(viewport, analysis.blocks) : undefined;
        body.editor.trackAnchor(anchor);
        pendingAnchor.current = anchor ? { anchor, sameRevision: true } : undefined;
        if (position !== undefined && reading.source === body.editor.source()) {
          body.editor.select({ anchor: position, head: position });
        }
      }
      if (body.editor.setSourceMode(next === "source")) {
        modeRef.current = next;
        setMode(next);
        requestAnimationFrame(() => {
          if (modeRef.current === next) body.editor.focus();
        });
      }
    },
    [analysis, body, mode, reading, restoringVersion, writable],
  );

  useEffect(() => {
    if (createdDocument !== documentId || !writable || modeRef.current !== "read") return;
    enterEditor("preview", 0);
    clearCreatedDocument();
  }, [clearCreatedDocument, createdDocument, documentId, enterEditor, writable]);

  const leaveEditor = useCallback(() => {
    if (body.editor.isComposing()) return;
    const source = body.editor.source();
    const next =
      source === reading.source
        ? reading
        : { source, analysis: reanalyzeMarkdown(source, documentId, reading) };
    if (mode !== "read") {
      const viewport = canvas.current?.closest("main");
      const anchor = viewport
        ? body.editor.captureAnchor(viewport, next.analysis.blocks)
        : undefined;
      pendingAnchor.current = restoringEditor.current
        ? body.editor.trackedAnchor()
        : anchor
          ? { anchor, sameRevision: true }
          : undefined;
      body.editor.trackAnchor(undefined);
    }
    modeRef.current = "read";
    setReading(next);
    setMode("read");
  }, [body, documentId, mode, reading]);

  async function restore(commitId: string) {
    if (body.editor.isComposing()) throw new Error("请先完成正在输入的内容");
    setRestoringVersion(true);
    leaveEditor();
    try {
      await body.saves.flush();
      if (body.saves.isDirty()) throw new Error("请先保存本地修改");
      const baseRevision = body.saves.confirmed().revision;
      const result = await api.restoreDocument(documentId, { baseRevision, commitId });
      if (body.sync(result.snapshot)) {
        const source = body.editor.source();
        setReading((previous) => ({
          source,
          analysis: reanalyzeMarkdown(source, documentId, previous),
        }));
      }
      setDocumentSnapshot(result.snapshot);
      return result;
    } finally {
      setRestoringVersion(false);
    }
  }

  const mountBody = useCallback(
    (parent: HTMLDivElement | null) => {
      if (parent) return body.editor.mount(parent);
    },
    [body],
  );

  useLayoutEffect(() => {
    const viewport = canvas.current?.closest("main");
    const placement = pendingAnchor.current;
    if (!viewport || !placement) return;
    if (mode === "read") {
      return restoreReaderAnchor(
        viewport,
        analysis.blocks,
        placement.anchor,
        placement.sameRevision,
      );
    }
    restoringEditor.current = true;
    const frame = requestAnimationFrame(() => {
      const next = body.editor.trackedAnchor() ?? placement;
      const current = body.editor.source();
      const blocks =
        current === reading.source
          ? analysis.blocks
          : reanalyzeMarkdown(current, documentId, reading).blocks;
      void body.editor
        .restoreAnchor(viewport, blocks, next.anchor, next.sameRevision, true)
        .finally(() => {
          restoringEditor.current = false;
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [analysis, body, documentId, mode, reading]);

  useEffect(() => {
    const surface = canvas.current;
    if (mode !== "read" || !writable || !surface) return;
    function click(event: MouseEvent) {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        target.closest("a, button, input") ||
        !window.getSelection()?.isCollapsed
      )
        return;
      const element = target.closest<HTMLElement>("[data-block-id]");
      const block = analysis.blocks.find((item) => item.id === element?.dataset.blockId);
      if (block) enterEditor("preview", block.from);
    }
    surface.addEventListener("click", click);
    return () => surface.removeEventListener("click", click);
  }, [analysis, enterEditor, mode, writable]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || body.editor.isComposing()) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "s" && writable) {
        event.preventDefault();
        void flush();
      } else if (event.altKey && key === "e" && writable) {
        event.preventDefault();
        enterEditor(event.shiftKey ? "source" : "preview");
      } else if (
        event.key === "Escape" &&
        mode !== "read" &&
        event.target instanceof Node &&
        canvas.current?.contains(event.target)
      ) {
        event.preventDefault();
        leaveEditor();
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [body, enterEditor, flush, leaveEditor, mode, writable]);

  const titleIsFirstHeading =
    mode === "read" && analysis.headings[0]?.level === 1 && analysis.headings[0].label === title;

  return (
    <div
      className={styles.page}
      data-editing={mode !== "read" || undefined}
      data-tool-open={Boolean(tool) || undefined}
      style={
        {
          "--focus-measure": focus.width ? `${focus.width}px` : undefined,
          "--focus-tool-inset": focus.toolInset ? `${focus.toolInset}px` : undefined,
          "--tool-width": `${preferences.toolsWidth}px`,
        } as CSSProperties
      }
    >
      <header className={styles.header} data-reading-header>
        {!titleIsFirstHeading && <h1 className={styles.title}>{title}</h1>}
      </header>
      <div className={styles.documentTools} ref={toolbar}>
        {mode !== "read" && (
          <Button className={styles.actionButton} onPress={leaveEditor}>
            返回阅读
          </Button>
        )}
        {analysis.headings.length > 0 && mode === "read" && (
          <ToggleButton
            isSelected={tool === "contents"}
            onChange={(selected) => setTool(selected ? "contents" : undefined)}
            className={styles.actionButton}
          >
            文档目录
          </ToggleButton>
        )}
        {outlineEnabled && (
          <ToggleButton
            isSelected={tool === "outline"}
            onChange={(selected) => setTool(selected ? "outline" : undefined)}
            className={styles.actionButton}
          >
            提纲
          </ToggleButton>
        )}
        <ToggleButton
          isSelected={tool === "history"}
          onChange={(selected) => setTool(selected ? "history" : undefined)}
          className={styles.actionButton}
        >
          版本
        </ToggleButton>
        <ToggleButton
          {...(aiOpened && { "aria-controls": aiPanelId })}
          isSelected={tool === "ai"}
          onPressStart={rememberReadingSelection}
          onChange={(selected) => {
            if (selected) setAiOpened(true);
            else savedSelection.current = undefined;
            setTool(selected ? "ai" : undefined);
          }}
          className={styles.actionButton}
        >
          文档 AI
        </ToggleButton>
        {mode === "read" && (
          <ToggleButton
            isSelected={tool === "references"}
            onChange={(selected) => setTool(selected ? "references" : undefined)}
            className={styles.actionButton}
          >
            引用
          </ToggleButton>
        )}
        {(writable || semantic.length > 0) && (
          <MenuTrigger>
            <Button
              aria-label="文档更多"
              className={styles.actionButton}
              isDisabled={restoringVersion}
            >
              更多
            </Button>
            <Popover className={styles.menu}>
              <Menu
                onAction={(key) => {
                  if (key === "edit") enterEditor("preview");
                  if (key === "source") enterEditor(mode === "source" ? "preview" : "source");
                  if (key === "metadata") setTool("metadata");
                  if (key === "semantic") moveSemantic(0);
                  if (key === "outline") {
                    setOutlineRequested(true);
                    setTool("outline");
                  }
                }}
              >
                {mode === "read" && writable && <MenuItem id="edit">编辑正文</MenuItem>}
                {writable && (
                  <MenuItem id="source">{mode === "source" ? "即时预览" : "完整源码"}</MenuItem>
                )}
                {writable && <MenuItem id="metadata">文档属性</MenuItem>}
                {writable && !outlineEnabled && <MenuItem id="outline">添加提纲</MenuItem>}
                {mode === "read" && semantic.length > 0 && (
                  <MenuItem id="semantic">聚焦此处</MenuItem>
                )}
              </Menu>
            </Popover>
          </MenuTrigger>
        )}
      </div>
      <div className={styles.documentGrid} data-tool={tool} data-reading-grid>
        <section
          className={styles.toolPane}
          ref={toolPane}
          hidden={!tool}
          aria-label="文档辅助区"
          tabIndex={-1}
        >
          {aiOpened && (
            <div hidden={tool !== "ai"}>
              <AiPanel
                id={aiPanelId}
                workspace={workspace}
                documentId={documentId}
                documents={documents ?? []}
                writable={writable}
                resolveContext={resolveAiContext}
              />
            </div>
          )}
          {tool === "contents" && (
            <nav className={styles.contents} aria-label="文档目录">
              {analysis.headings.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${encodeURIComponent(heading.id)}`}
                  style={{ paddingInlineStart: Math.max(heading.level - 2, 0) * 12 + 8 }}
                  onClick={(event) => {
                    event.preventDefault();
                    window.document.getElementById(heading.id)?.scrollIntoView({ block: "start" });
                  }}
                >
                  {heading.label}
                </a>
              ))}
            </nav>
          )}
          {outline.data && (
            <OutlineCanvas
              snapshot={outline.data}
              visible={tool === "outline"}
              writable={writable}
              write={writeOutline}
              confirmed={confirmOutline}
              readCurrent={() => api.getOutline(documentId)}
              register={setOutlineSession}
            />
          )}
          {tool === "outline" && outline.isError && (
            <p role="alert" className={styles.sideError}>
              无法打开提纲
            </p>
          )}
          {tool === "metadata" && (
            <MetadataPanel
              editor={body.editor}
              onApply={() => {
                if (mode === "read") {
                  const source = body.editor.source();
                  setReading((previous) => ({
                    source,
                    analysis: reanalyzeMarkdown(source, documentId, previous),
                  }));
                }
                setTool(undefined);
              }}
              openSource={() => {
                setTool(undefined);
                enterEditor("source", 0);
              }}
            />
          )}
          {tool === "history" && (
            <VersionPanel
              workspace={workspace}
              documentId={documentId}
              writable={writable}
              onRestore={restore}
            />
          )}
          {tool === "references" && (
            <DocumentReferencesPanel workspace={workspace} document={documentId} />
          )}
        </section>
        <div
          className={styles.canvas}
          data-editable={writable || undefined}
          data-reading-measure
          ref={canvas}
        >
          {mode === "read" ? (
            <ReaderSurface
              analysis={analysis}
              label={title}
              activeBlocks={selectedBlock?.ids}
              onKeyDown={readerShortcut}
              resolveLink={resolveLink}
              resolveImage={resolveImage}
            />
          ) : (
            <div ref={mountBody} />
          )}
        </div>
      </div>
      {mode === "read" && selectedBlock && (
        <Group className={styles.semanticControls} aria-label="语义聚焦">
          <Button
            className={styles.actionButton}
            isDisabled={semanticIndex === 0}
            onPress={() => moveSemantic(-1)}
          >
            上一块
          </Button>
          <Button className={styles.actionButton} onPress={() => moveSemantic(0)}>
            返回焦点
          </Button>
          <Button
            className={styles.actionButton}
            isDisabled={semanticIndex === semantic.length - 1}
            onPress={() => moveSemantic(1)}
          >
            下一块
          </Button>
          {navigator.clipboard && (
            <Button
              className={styles.actionButton}
              onPress={() => {
                const selectedText = window.getSelection()?.toString();
                const selection = contextSelection({
                  source: reading.source,
                  documentId,
                  focused: selectedBlock,
                });
                if (selection.kind === "block")
                  void navigator.clipboard
                    .writeText(selectedText || selection.text)
                    .catch(() => {});
              }}
            >
              复制
            </Button>
          )}
          <Button className={styles.actionButton} onPress={() => setSemanticBlock(undefined)}>
            清除聚焦
          </Button>
        </Group>
      )}
      <div className={styles.saveNotices}>
        <SaveNotice saves={body.saves} editor={body.editor} kind="body" />
        {outlineSession && (
          <SaveNotice saves={outlineSession.saves} editor={outlineSession.editor} kind="outline" />
        )}
      </div>
    </div>
  );
}
