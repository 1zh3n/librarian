import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button, Group, Menu, MenuItem, MenuTrigger, Popover } from "../../ui/primitives";
import { Tabs } from "../../ui/Tabs";
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
import { readerCaretOffset, readerSelection } from "../ai/readerSelection";
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
const documentTabs = [
  { id: "outline", label: "提纲", icon: "align-left" },
  { id: "ai", label: "AI", icon: "sparkles" },
  { id: "history", label: "版本", icon: "history" },
  { id: "references", label: "引用", icon: "link" },
] as const;
type DocumentTab = (typeof documentTabs)[number]["id"];
type Tool = DocumentTab | "contents" | "metadata";

function isDocumentTab(value: unknown): value is DocumentTab {
  return documentTabs.some(({ id }) => id === value);
}

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
  const {
    focus,
    preferences,
    layoutSelection,
    createdDocument,
    clearCreatedDocument,
    navigationCancelled,
  } = useReaderLayout();
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
      hideMetadataInPreview: true,
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
    selection: number;
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
        ? "ai"
        : preferences.layout === "writing" && outlineEnabled
          ? "outline"
          : undefined;
  const tool = focus.active
    ? focusTool?.activation === focus.activation
      ? focusTool?.tool
      : undefined
    : normalTool?.layout === preferences.layout && normalTool.selection === layoutSelection
      ? normalTool.tool
      : defaultTool;
  const toolAnchor = useRef<ReturnType<typeof captureReaderAnchor>>(undefined);
  const toolPane = useRef<HTMLElement>(null);
  const openToolButton = useRef<HTMLButtonElement>(null);
  const [lastTab, setLastTab] = useState<DocumentTab>();
  const initialTab = outlineEnabled ? "outline" : "ai";
  const rememberedTab =
    lastTab === "outline" && !outlineEnabled ? initialTab : (lastTab ?? initialTab);
  const paneId = `document-tools-${documentId}`;
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
      else setNormalTool({ layout: preferences.layout, selection: layoutSelection, tool: next });
    },
    [focus.activation, layoutSelection, preferences.layout],
  );
  function setTool(next: Tool | undefined) {
    if (next === tool) return;
    if (isDocumentTab(next)) setLastTab(next);
    const viewport = canvas.current?.closest("main");
    toolAnchor.current =
      viewport && modeRef.current === "read"
        ? captureReaderAnchor(viewport, analysis.blocks)
        : undefined;
    returnFromTool.current = !next;
    moveToTool.current = Boolean(next && !tool);
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
      }
    }
    chooseTool(next);
  }
  const outline = useQuery({ ...outlineQuery(workspace, documentId), enabled: outlineEnabled });
  const canvas = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<{ source: string; range: Range } | undefined>(undefined);
  const savedEditorSelection = useRef<{ source: string; anchor: number; head: number }>(undefined);
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
      const selectedTab = pane.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      (selectedTab ?? pane).focus({ preventScroll: true });
      if (inlineVisit.current) {
        const top = pane.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        const inset = (toolbar.current?.offsetHeight ?? 0) + 8;
        if (top < inset || top + Math.min(pane.offsetHeight, 88) > viewport.clientHeight) {
          viewport.scrollTop += top - inset;
        }
        return;
      }
    }
    if (!tool && returnFromTool.current) {
      const visit = inlineVisit.current;
      inlineVisit.current = undefined;
      returnFromTool.current = false;
      (visit?.opener?.isConnected ? visit.opener : openToolButton.current)?.focus({
        preventScroll: true,
      });
      if (visit?.anchor && modeRef.current === "read") {
        return restoreReaderAnchor(
          viewport,
          analysis.blocks,
          visit.anchor,
          visit.source === reading.source,
        );
      }
      if (visit) {
        viewport.scrollTop = visit.scrollTop;
        return;
      }
    }
    if (anchor && modeRef.current === "read") {
      return restoreReaderAnchor(viewport, analysis.blocks, anchor, true);
    }
  }, [tool, analysis.blocks, reading.source]);

  useEffect(() => {
    const pane = toolPane.current;
    function closeDocumentTool(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape" || !tool) return;
      event.preventDefault();
      savedSelection.current = undefined;
      savedEditorSelection.current = undefined;
      const viewport = canvas.current?.closest("main");
      toolAnchor.current =
        viewport && modeRef.current === "read"
          ? captureReaderAnchor(viewport, analysis.blocks)
          : undefined;
      returnFromTool.current = true;
      chooseTool(undefined);
    }
    pane?.addEventListener("keydown", closeDocumentTool);
    return () => pane?.removeEventListener("keydown", closeDocumentTool);
  }, [analysis.blocks, chooseTool, tool]);

  const rememberReadingSelection = useCallback(() => {
    if (modeRef.current !== "read") return;
    const selection = window.getSelection();
    const surface = canvas.current;
    if (!surface || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (surface.contains(range.startContainer) && surface.contains(range.endContainer)) {
      savedSelection.current = range.collapsed ? undefined : { source: reading.source, range };
      if (!range.collapsed) savedEditorSelection.current = undefined;
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
    savedEditorSelection.current = undefined;
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
    const editor =
      mode === "read"
        ? savedEditorSelection.current?.source === source
          ? savedEditorSelection.current
          : undefined
        : body.editor.selection();
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
        savedSelection.current = undefined;
        savedEditorSelection.current = undefined;
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
      const selection = body.editor.selection();
      savedEditorSelection.current =
        selection.anchor !== selection.head ? { source, ...selection } : undefined;
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

  useEffect(() => {
    const surface = canvas.current;
    if (!surface || mode !== "preview") return;
    function leaveWhenFocusMoves() {
      queueMicrotask(() => {
        if (modeRef.current === "preview" && !surface?.contains(window.document.activeElement)) {
          leaveEditor();
        }
      });
    }
    function leaveAfterComposition() {
      requestAnimationFrame(leaveWhenFocusMoves);
    }
    surface.addEventListener("focusout", leaveWhenFocusMoves);
    surface.addEventListener("compositionend", leaveAfterComposition);
    return () => {
      surface.removeEventListener("focusout", leaveWhenFocusMoves);
      surface.removeEventListener("compositionend", leaveAfterComposition);
    };
  }, [leaveEditor, mode]);

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
      if (!element || !block) return;
      const caret = window.document.caretPositionFromPoint?.(event.clientX, event.clientY);
      const selection = window.getSelection();
      const point = caret
        ? { node: caret.offsetNode, offset: caret.offset }
        : selection?.anchorNode
          ? { node: selection.anchorNode, offset: selection.anchorOffset }
          : undefined;
      const offset =
        point && element.contains(point.node) && surface
          ? readerCaretOffset(surface, point, reading.source, analysis)
          : undefined;
      enterEditor("preview", offset ?? block.from);
    }
    surface.addEventListener("click", click);
    return () => surface.removeEventListener("click", click);
  }, [analysis, enterEditor, mode, reading.source, writable]);

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
        requestAnimationFrame(() =>
          canvas.current?.querySelector("article")?.focus({ preventScroll: true }),
        );
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [body, enterEditor, flush, leaveEditor, mode, writable]);

  const titleIsFirstHeading =
    mode !== "source" && analysis.headings[0]?.level === 1 && analysis.headings[0].label === title;

  return (
    <div
      className={styles.page}
      data-editing={mode !== "read" || undefined}
      style={
        {
          "--focus-measure": focus.width ? `${focus.width}px` : undefined,
          "--focus-tool-inset": focus.toolInset ? `${focus.toolInset}px` : undefined,
          "--tool-width": `${preferences.toolsWidth}px`,
        } as CSSProperties
      }
    >
      <div className={styles.documentTools} ref={toolbar}>
        {!tool && (
          <Button
            ref={openToolButton}
            aria-label="打开文档辅助区"
            aria-controls={paneId}
            aria-expanded={false}
            onPressStart={rememberReadingSelection}
            onPress={() => setTool(rememberedTab)}
            className={styles.iconButton}
          >
            <span className={styles.icon} data-icon="panel-right" aria-hidden="true" />
          </Button>
        )}
        {(writable || semantic.length > 0 || analysis.headings.length > 0) && (
          <MenuTrigger>
            <Button
              aria-label="文档更多"
              className={styles.iconButton}
              isDisabled={restoringVersion}
            >
              <span className={styles.icon} data-icon="ellipsis" aria-hidden="true" />
            </Button>
            <Popover className={styles.menu}>
              <Menu
                onAction={(key) => {
                  if (key === "contents") setTool("contents");
                  if (key === "source") enterEditor(mode === "source" ? "preview" : "source");
                  if (key === "metadata") setTool("metadata");
                  if (key === "semantic") moveSemantic(0);
                  if (key === "outline") {
                    setOutlineRequested(true);
                    setTool("outline");
                  }
                }}
              >
                {mode === "read" && analysis.headings.length > 0 && (
                  <MenuItem id="contents">文档目录</MenuItem>
                )}
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
          id={paneId}
          data-tabbed={isDocumentTab(tool) || undefined}
          hidden={!tool}
          aria-label="文档辅助区"
          tabIndex={-1}
        >
          <Button
            className={styles.closePane}
            aria-label="收起文档辅助区"
            onPress={() => {
              savedSelection.current = undefined;
              savedEditorSelection.current = undefined;
              setTool(undefined);
            }}
          >
            <span className={styles.icon} data-icon="panel-right-close" aria-hidden="true" />
          </Button>
          <div hidden={!isDocumentTab(tool)}>
            <Tabs
              className={styles.toolTabs}
              selectedKey={isDocumentTab(tool) ? tool : rememberedTab}
              onSelectionChange={(key) => {
                if (isDocumentTab(tool) && isDocumentTab(key)) setTool(key);
              }}
            >
              <Tabs.List className={styles.tabList} aria-label="文档工具">
                {documentTabs
                  .filter(({ id }) => id !== "outline" || outlineEnabled)
                  .map(({ id, label, icon }) => (
                    <Tabs.Tab key={id} id={id} className={styles.toolTab}>
                      <span className={styles.icon} data-icon={icon} aria-hidden="true" />
                      {label}
                    </Tabs.Tab>
                  ))}
              </Tabs.List>
              {outlineEnabled && (
                <Tabs.Panel id="outline" className={styles.tabPanel} shouldForceMount>
                  {outline.data && (
                    <OutlineCanvas
                      snapshot={outline.data}
                      visible={tool === "outline"}
                      focusOnCreate={outlineRequested && !snapshot.document.outlineEnabled}
                      writable={writable}
                      write={writeOutline}
                      confirmed={confirmOutline}
                      readCurrent={() => api.getOutline(documentId)}
                      register={setOutlineSession}
                    />
                  )}
                  {outline.isError && (
                    <p role="alert" className={styles.sideError}>
                      无法打开提纲
                    </p>
                  )}
                  {outline.isPending && <output className={styles.sideError}>正在打开提纲…</output>}
                </Tabs.Panel>
              )}
              <Tabs.Panel id="ai" className={styles.tabPanel} shouldForceMount>
                <AiPanel
                  active={tool === "ai"}
                  workspace={workspace}
                  documentId={documentId}
                  documents={documents ?? []}
                  writable={writable}
                  resolveContext={resolveAiContext}
                />
              </Tabs.Panel>
              <Tabs.Panel id="history" className={styles.tabPanel}>
                {tool === "history" && (
                  <VersionPanel
                    workspace={workspace}
                    documentId={documentId}
                    writable={writable}
                    onRestore={restore}
                  />
                )}
              </Tabs.Panel>
              <Tabs.Panel id="references" className={styles.tabPanel}>
                {tool === "references" && (
                  <DocumentReferencesPanel workspace={workspace} document={documentId} />
                )}
              </Tabs.Panel>
            </Tabs>
          </div>
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
        </section>
        <div
          className={styles.canvas}
          data-editable={writable || undefined}
          data-reading-measure
          ref={canvas}
        >
          {!titleIsFirstHeading && <h1 className={styles.title}>{title}</h1>}
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
