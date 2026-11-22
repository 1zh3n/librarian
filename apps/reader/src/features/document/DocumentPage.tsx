import { Icon } from "../../ui/Icon";
import { Feedback } from "../../ui/Feedback";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "../../ui/Button";
import { ActionMenu } from "../../ui/Menu";
import { DocumentToolPanel, useDocumentTools } from "./DocumentToolPanel";
import { DocumentAiPanel } from "./DocumentAiPanel";
import type { Tool } from "./DocumentToolPanel";
import { api, ApiError } from "../../api/client";
import type { AiContext, AssetUpload, DocumentSnapshot, OutlineSnapshot } from "../../api/client";
import {
  DocumentMoved,
  documentQuery,
  documentsQuery,
  outlineQuery,
  workspaceKeys,
} from "../../api/queries";
import { blockAtOffset, captureReaderAnchor, restoreReaderAnchor } from "../../markdown/anchors";
import type { EditorMountAnchor } from "../../editor/codemirror/adapter";
import type { AnchorPlacement } from "../../markdown/anchors";
import { analyzeMarkdown } from "../../markdown/analyze";
import { reanalyzeMarkdown } from "../../markdown/reanalyze";
import { isInlineImagePath } from "../../markdown/imagePath";
import { relativeDocumentPath } from "../../markdown/relativePath";
import { ReaderSurface } from "../../markdown/ReaderSurface";
import { AiPanel } from "../ai/AiPanel";
import { ContextUnavailable } from "../ai/aiContext";
import { readerSelection } from "../ai/readerSelection";
import { contextSelection } from "../reading/contextSelection";
import { isEditingTarget, useReaderLayout } from "../reading/readingFocus";
import {
  isRepeatedSemanticBlock,
  renderedBlock,
  semanticBlocks,
  showSemanticBlock,
  visibleSemanticBlock,
} from "../reading/semanticFocus";
import { VersionPanel } from "../revisions/VersionPanel";
import { openMarkdownSession } from "./documentSession";
import { DocumentContents, headingAtReadingPosition } from "./DocumentContents";
import { DocumentReferencesPanel } from "./DocumentReferencesPanel";
import { readingPositionAtClick, textCaretAtClick } from "./readingPositionAtClick";
import { placeInlineTool } from "./inlineTool";
import { MetadataPanel } from "./MetadataPanel";
import { OutlineCanvas } from "./OutlineCanvas";
import type { OutlineSession } from "./OutlineCanvas";
import type { MarkdownWrite } from "./saveController";
import { parseCitationHash } from "./sourceVisit";
import type { CitationDraft } from "./citationHistory";
import type { AiTranscriptVisit, SourceVisit } from "./sourceVisit";
import { SaveNotice } from "./SaveNotice";
import { ImageInsertDialog } from "./ImageInsertDialog";
import {
  assetsDirectory,
  imageUploadError,
  imageValidationError,
  markdownForImages,
} from "./imageInsert";
import { NotificationPortal } from "../../ui/NotificationStack";
import styles from "./DocumentPage.module.css";

type Mode = "read" | "preview" | "source";
type EditorSelection = { source: string; anchor: number; head: number; blockId?: string };
type DocumentVisit = SourceVisit & { composingSelection?: EditorSelection };
type SourceNavigation = {
  citationDraft: CitationDraft | undefined;
  visit: DocumentVisit | undefined;
  onSourceVisit: (sourceId: string, capture: () => DocumentVisit) => void;
};

function unavailableDocument(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function DocumentPage({
  workspace,
  document,
  writable,
  visit,
  citationDraft,
  onSourceVisit,
}: SourceNavigation & {
  workspace: string;
  document: string;
  writable: boolean;
}) {
  const result = useQuery(documentQuery(workspace, document));
  if (result.error instanceof DocumentMoved) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/documents/$documentId"
        params={{ workspaceId: result.error.workspaceId, documentId: document }}
        hash={true}
        replace
      />
    );
  }
  if (result.isError && (!result.data || unavailableDocument(result.error))) {
    return (
      <Feedback tone="error" className={styles.message}>
        {result.error instanceof ApiError && result.error.status === 404
          ? "此文档不存在"
          : "无法读取文档"}
      </Feedback>
    );
  }
  if (!result.data) {
    return (
      <Feedback tone="status" className={styles.message}>
        正在打开文档…
      </Feedback>
    );
  }

  return (
    <DocumentWorkspace
      workspace={workspace}
      snapshot={result.data}
      writable={writable}
      visit={visit}
      citationDraft={citationDraft}
      onSourceVisit={onSourceVisit}
    />
  );
}

function DocumentWorkspace({
  workspace,
  snapshot,
  writable,
  visit: returnVisit,
  citationDraft,
  onSourceVisit,
}: SourceNavigation & {
  workspace: string;
  snapshot: DocumentSnapshot;
  writable: boolean;
}) {
  const { id: documentId, title } = snapshot.document;
  const moreButton = useRef<HTMLButtonElement>(null);
  const {
    focus,
    preferences,
    layoutSelection,
    createdDocument,
    clearCreatedDocument,
    navigationCancelled,
    renameDocument,
    draft: draftRef,
  } = useReaderLayout();
  const navigate = useNavigate();
  const { history } = useRouter();
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
      if (!relative) {
        return /^(?:https?:|data:image\/)/iu.test(src) ? undefined : null;
      }
      return isInlineImagePath(relative.path) ? api.workspaceAsset(workspace, relative.path) : null;
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
      documentBody: true,
      resolveImage,
      write: async ({ markdown, baseRevision }) => {
        if (baseRevision === null) throw new Error("正文缺少保存版本");
        await queryClient.cancelQueries({ queryKey: bodyKey, exact: true });
        return api.saveDocument(documentId, { markdown, baseRevision });
      },
      confirmed: setDocumentSnapshot,
      readCurrent: () => api.getDocument(documentId),
    }),
  );
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageNotice, setImageNotice] = useState<
    { tone: "error" | "success" | "status"; text: string } | undefined
  >();
  const imageNoticeTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (imageNoticeTimer.current !== undefined) window.clearTimeout(imageNoticeTimer.current);
    },
    [],
  );
  const showImageNotice = useCallback(
    (notice: { tone: "error" | "success" | "status"; text: string }) => {
      if (imageNoticeTimer.current !== undefined) window.clearTimeout(imageNoticeTimer.current);
      setImageNotice(notice);
      if (notice.tone === "success") {
        imageNoticeTimer.current = window.setTimeout(() => setImageNotice(undefined), 2_500);
      }
    },
    [],
  );
  const insertImageFiles = useCallback(
    async (files: File[], at?: number) => {
      const invalid = imageValidationError(files);
      if (invalid) throw new Error(invalid);
      if (imageBusy) throw new Error("已有图片正在上传，请稍候。");
      setImageBusy(true);
      const uploaded: AssetUpload[] = [];
      try {
        for (const file of files) {
          const form = new FormData();
          form.set("operationId", crypto.randomUUID());
          form.set("targetDirectory", assetsDirectory(path));
          form.set("fileName", file.name);
          form.set("conflictPolicy", "rename");
          form.set("file", file, file.name);
          uploaded.push(await api.uploadWorkspaceAsset(workspace, form));
        }
        body.editor.insertMarkdown(markdownForImages(path, uploaded), at);
      } catch (error) {
        if (uploaded.length) body.editor.insertMarkdown(markdownForImages(path, uploaded), at);
        const message = imageUploadError(error);
        throw new Error(
          uploaded.length ? `已插入 ${uploaded.length} 张，其余失败：${message}` : message,
        );
      } finally {
        setImageBusy(false);
      }
    },
    [body, imageBusy, path, workspace],
  );
  const insertDroppedImages = useCallback(
    async (files: File[], at?: number) => {
      if (!writable) return;
      showImageNotice({ tone: "status", text: `正在上传 ${files.length} 张图片…` });
      try {
        await insertImageFiles(files, at);
        showImageNotice({ tone: "success", text: `已插入 ${files.length} 张图片` });
      } catch (error) {
        showImageNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "图片上传失败，请重试。",
        });
      }
    },
    [insertImageFiles, showImageNotice, writable],
  );
  useLayoutEffect(() => {
    body.editor.setImageHandler((files, at) => void insertDroppedImages(files, at));
  }, [body, insertDroppedImages]);
  async function insertImagesFromDialog(files: File[]) {
    await insertImageFiles(files);
    setImageDialogOpen(false);
    requestAnimationFrame(() => body.editor.focus());
  }
  function closeImageDialog() {
    setImageDialogOpen(false);
    requestAnimationFrame(() => moreButton.current?.focus());
  }
  const [reading, setReading] = useState(() => ({
    source: snapshot.markdown,
    analysis: analyzeMarkdown(snapshot.markdown, documentId),
  }));
  const analysis = reading.analysis;
  const location = useLocation();
  const locationHash = location.hash;
  const citation = useMemo(() => parseCitationHash(locationHash), [locationHash]);
  const [mode, setMode] = useState<Mode>("read");
  const modeRef = useRef<Mode>("read");
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [outlineRequested, setOutlineRequested] = useState(false);
  const [outlineSession, setOutlineSession] = useState<OutlineSession>();
  const outlineEnabled = outlineRequested || snapshot.document.outlineEnabled;
  const showOutline = outlineEnabled || citation?.outline === true;
  const initialTool = returnVisit
    ? "layout"
    : citation
      ? citation.outline
        ? "outline"
        : "paper"
      : "layout";
  const { tool, rememberedTab, chooseTool } = useDocumentTools(
    showOutline,
    location.state.__TSR_key,
    initialTool,
  );
  const [aiOpen, setAiOpen] = useState(Boolean(returnVisit) || preferences.layout === "research");
  const layoutKey = `${preferences.layout}:${layoutSelection}`;
  const [aiLayout, setAiLayout] = useState(layoutKey);
  const aiLauncher = useRef<HTMLButtonElement>(null);
  if (aiLayout !== layoutKey) {
    setAiLayout(layoutKey);
    if (preferences.layout === "research") {
      chooseTool(undefined);
      setAiOpen(true);
    } else {
      setAiOpen(false);
    }
  }
  const savedSelection = useRef<{ source: string; range: Range } | undefined>(undefined);
  const toolAnchor = useRef<ReturnType<typeof captureReaderAnchor>>(undefined);
  const toolPane = useRef<HTMLElement>(null);
  const openToolButton = useRef<HTMLButtonElement>(null);
  const paneId = `document-tools-${documentId}`;
  const toolbar = useRef<HTMLDivElement>(null);
  const inlineVisit = useRef<{
    anchor: ReturnType<typeof captureReaderAnchor>;
    revision: string;
    scrollTop: number;
    opener: HTMLElement | undefined;
    passage: string | undefined;
  }>(
    returnVisit?.inline
      ? { ...returnVisit.inline, revision: returnVisit.revision, opener: undefined }
      : undefined,
  );
  const [contentsInitial, setContentsInitial] = useState<string>();
  const contentsDestination = useRef<HTMLElement | null>(null);
  const moveToTool = useRef(false);
  const returnFromTool = useRef(false);
  function setTool(next: Tool | undefined) {
    if (next === tool) return;
    if (next) setAiOpen(false);
    const viewport = canvas.current?.closest("main");
    if (next === "contents" && viewport) setContentsInitial(headingAtReadingPosition(viewport));
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
          revision: snapshot.revision,
          scrollTop: viewport.scrollTop,
          passage:
            savedSelection.current?.range.startContainer.parentElement?.closest<HTMLElement>(
              "[data-block-id]",
            )?.dataset.blockId ?? toolAnchor.current?.blockId,
          opener:
            active instanceof HTMLElement && toolbar.current?.contains(active) ? active : undefined,
        };
      }
    }
    chooseTool(next);
  }
  function openAi() {
    if (tool) setTool(undefined);
    setAiOpen(true);
  }
  function closeAi() {
    setAiOpen(false);
    requestAnimationFrame(() => aiLauncher.current?.focus({ preventScroll: true }));
  }
  const outline = useQuery({
    ...outlineQuery(workspace, documentId),
    enabled: showOutline,
    ...(citation?.outline && { staleTime: 0 }),
  });
  const outlineSnapshot = unavailableDocument(outline.error) ? undefined : outline.data;
  const missingCitedOutline =
    citation?.outline &&
    outline.isSuccess &&
    outlineSnapshot?.revision === null &&
    !outlineRequested;
  const sourceRevision = citation?.outline ? outlineSnapshot?.revision : snapshot.revision;
  const canvas = useRef<HTMLDivElement>(null);
  const savedEditorSelection = useRef<EditorSelection>(undefined);
  const pendingAnchor = useRef<AnchorPlacement | undefined>(undefined);
  const editorEntryScroll = useRef<number | undefined>(undefined);
  const mountAnchor = useRef<EditorMountAnchor | undefined>(undefined);

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

  const toolOpen = Boolean(tool);
  useLayoutEffect(() => {
    const pane = toolPane.current;
    const surface = canvas.current;
    const passage = inlineVisit.current?.passage;
    if (!toolOpen || mode !== "read" || !pane || !surface || !passage) return;
    const block = renderedBlock(surface, passage);
    if (block) return placeInlineTool(pane, block);
  }, [toolOpen, mode, analysis]);

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
      const destination = contentsDestination.current;
      contentsDestination.current = null;
      if (destination?.isConnected) {
        destination.focus({ preventScroll: true });
        destination.scrollIntoView({ block: "start" });
        return;
      }
      (visit?.opener?.isConnected ? visit.opener : openToolButton.current)?.focus({
        preventScroll: true,
      });
      if (visit?.anchor && modeRef.current === "read") {
        return restoreReaderAnchor(
          viewport,
          analysis.blocks,
          visit.anchor,
          visit.revision === body.saves.confirmed().revision &&
            body.saves.confirmed().markdown === reading.source,
        );
      }
      if (visit) {
        viewport.scrollTop = visit.scrollTop;
        return;
      }
    }
    if (anchor && modeRef.current === "read" && !(tool && inlineVisit.current)) {
      return restoreReaderAnchor(viewport, analysis.blocks, anchor, true);
    }
  }, [tool, analysis.blocks, reading.source, body]);

  function rememberSource(transcript: AiTranscriptVisit) {
    if (!transcript.sourceId) return;
    const viewport = canvas.current?.closest("main");
    if (!viewport) return;
    const inline = inlineVisit.current;
    const source = mode === "read" ? reading.source : body.editor.source();
    const selection = selectedContext(source);
    const visit = {
      documentId,
      transcript,
      reading: {
        anchor: captureReaderAnchor(viewport, analysis.blocks),
        scrollTop: viewport.scrollTop,
      },
      inline: inline && {
        anchor: inline.anchor,
        scrollTop: inline.scrollTop,
        passage: inline.passage,
      },
    };
    onSourceVisit(transcript.sourceId, () => {
      const confirmed = body.saves.confirmed();
      const saved = confirmed.markdown === source;
      return {
        ...visit,
        revision: confirmed.revision,
        selection: saved ? selection : undefined,
        ...(!saved &&
          selection &&
          body.editor.isComposing() && {
            composingSelection: { source, anchor: selection.from, head: selection.to },
          }),
      };
    });
  }

  const handledVisit = useRef<SourceVisit>(undefined);
  useLayoutEffect(() => {
    if (!returnVisit) {
      handledVisit.current = undefined;
      return;
    }
    if (handledVisit.current === returnVisit) return;
    const range = returnVisit.selection;
    savedEditorSelection.current =
      range && returnVisit.revision === snapshot.revision
        ? {
            source: snapshot.markdown,
            anchor: range.from,
            head: range.to,
            ...(range.blockId && { blockId: range.blockId }),
          }
        : returnVisit.composingSelection?.source === body.editor.source()
          ? returnVisit.composingSelection
          : undefined;
    inlineVisit.current = returnVisit.inline && {
      ...returnVisit.inline,
      revision: returnVisit.revision,
      opener: undefined,
    };
  }, [body, returnVisit, snapshot.revision, snapshot.markdown]);

  useEffect(() => {
    const viewport = canvas.current?.closest("main");
    if (!returnVisit || !aiOpen || !viewport || handledVisit.current === returnVisit) return;
    // The shell resets the scroller when document identity changes.
    let stop: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const { anchor, scrollTop } = returnVisit.reading;
      viewport.scrollTop = scrollTop;
      if (anchor)
        stop = restoreReaderAnchor(
          viewport,
          analysis.blocks,
          anchor,
          returnVisit.revision === snapshot.revision,
        );
      handledVisit.current = returnVisit;
    });
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [aiOpen, returnVisit, analysis.blocks, snapshot.revision]);

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
  useEffect(() => {
    const current = {
      id: documentId,
      save: async () => {
        await flush();
        return !isDirty();
      },
    };
    draftRef.current = current;
    return () => {
      if (draftRef.current === current) draftRef.current = undefined;
    };
  }, [documentId, draftRef, flush, isDirty]);
  function selectedContext(source: string) {
    const root = canvas.current;
    const stored = savedSelection.current;
    const editor: { anchor: number; head: number; blockId?: string } | undefined =
      mode === "read"
        ? savedEditorSelection.current?.source === source
          ? savedEditorSelection.current
          : undefined
        : body.editor.selection();
    const range = editor
      ? {
          from: Math.min(editor.anchor, editor.head),
          to: Math.max(editor.anchor, editor.head),
          ...(editor.blockId && { blockId: editor.blockId }),
        }
      : root && stored?.source === source
        ? readerSelection(root, stored.range, source, analysis)
        : undefined;
    return range && range.from < range.to
      ? range
      : source === reading.source && selectedBlock
        ? { from: selectedBlock.from, to: selectedBlock.to, blockId: selectedBlock.id }
        : undefined;
  }
  async function resolveAiContext(): Promise<AiContext[]> {
    const confirmed = body.saves.confirmed();
    const source = mode === "read" ? reading.source : body.editor.source();
    const local = selectedContext(source);
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

  useEffect(
    () =>
      history.block({
        enableBeforeUnload: isDirty,
        blockerFn: async ({ currentLocation, nextLocation, action }) => {
          if (!isDirty()) return false;
          // A citation's history entry captures the selection against the confirmed revision.
          const opensCitation =
            action === "PUSH" &&
            nextLocation.state.readerCitation &&
            nextLocation.state.readerCitationOrigin === currentLocation.state.__TSR_key;
          const sameDocument = currentLocation.pathname === nextLocation.pathname;
          if (sameDocument) {
            // The source view keeps the editor mounted until the IME commits.
            if (!opensCitation || body.editor.isComposing() || !body.saves.isDirty()) return false;
            await body.saves.flush();
          } else {
            await flush();
          }
          const unsaved = sameDocument ? body.saves.isDirty() : isDirty();
          const blocked = unsaved && !window.confirm("还有未保存的内容。确定离开文档？");
          if (blocked) navigationCancelled(nextLocation.pathname);
          return blocked;
        },
      }),
    [body, history, isDirty, flush, navigationCancelled],
  );

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

  const blankLineOnMount = useRef(false);
  const enterEditor = useCallback(
    (
      next: "preview" | "source",
      position?: number | "blankLine",
      clickedAnchor?: Omit<EditorMountAnchor, "viewport">,
    ) => {
      if (!writable || restoringVersion || body.editor.isComposing()) return;
      if (mode === "read") {
        savedSelection.current = undefined;
        savedEditorSelection.current = undefined;
        const viewport = canvas.current?.closest("main");
        blankLineOnMount.current = position === "blankLine";
        const sameSource = reading.source === body.editor.source();
        const anchor =
          viewport && sameSource ? captureReaderAnchor(viewport, analysis.blocks) : undefined;
        body.editor.trackAnchor(anchor);
        mountAnchor.current = undefined;
        if (viewport && clickedAnchor && sameSource) {
          mountAnchor.current = {
            viewport,
            ...clickedAnchor,
            keepCaretVisible: position === "blankLine",
          };
        } else if (viewport && anchor) {
          mountAnchor.current = {
            viewport,
            sourceOffset: anchor.sourceOffset,
            screenTop: viewport.getBoundingClientRect().top + anchor.insetPx,
          };
        }
        // With no previous edit or pointer, start typing in the visible passage.
        const firstEntry = next === "preview" && editorEntryScroll.current === undefined;
        const at =
          position ?? (firstEntry ? (anchor?.sourceOffset ?? analysis.blocks[0]?.from) : undefined);
        if (typeof at === "number" && sameSource) {
          body.editor.select({ anchor: at, head: at });
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

  const continueAfterSaveConflict = useCallback(() => {
    const source = body.editor.source();
    setReading((previous) =>
      source === previous.source
        ? previous
        : { source, analysis: reanalyzeMarkdown(source, documentId, previous) },
    );
    enterEditor("preview");
  }, [body, documentId, enterEditor]);

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
      const stayedAtEntry = viewport && viewport.scrollTop === editorEntryScroll.current;
      const entry = stayedAtEntry ? body.editor.trackedAnchor() : undefined;
      pendingAnchor.current = entry ?? (anchor ? { anchor, sameRevision: true } : undefined);
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
      if (!parent) return;
      if (blankLineOnMount.current) {
        blankLineOnMount.current = false;
        body.editor.moveToFinalBlankLine();
      }
      const unmount = body.editor.mount(parent, true, mountAnchor.current);
      editorEntryScroll.current = parent.closest("main")?.scrollTop;
      mountAnchor.current = undefined;
      return unmount;
    },
    [body],
  );

  useLayoutEffect(() => {
    const viewport = canvas.current?.closest("main");
    const placement = pendingAnchor.current;
    if (mode !== "read" || !viewport || !placement) return;
    return restoreReaderAnchor(viewport, analysis.blocks, placement.anchor, placement.sameRevision);
  }, [analysis.blocks, mode]);

  const handledCitation = useRef<{ citation: typeof citation; entry: string | undefined }>(
    undefined,
  );
  const citationEntry = location.state.__TSR_key;
  useLayoutEffect(() => {
    if (!citation || returnVisit) {
      handledCitation.current = undefined;
      return;
    }
    if (
      handledCitation.current?.citation === citation &&
      handledCitation.current.entry === citationEntry
    )
      return;
    const destination = citation.outline ? "outline" : undefined;
    if (tool !== destination) return;
    if (!destination && mode !== "read") {
      const showReading = () => {
        leaveEditor();
        pendingAnchor.current = undefined;
      };
      if (body.editor.isComposing()) {
        const surface = canvas.current;
        // The editor commits composition on the frame following compositionend.
        const whenCommitted = () => {
          if (!body.editor.isComposing()) showReading();
        };
        let frame = requestAnimationFrame(whenCommitted);
        const afterComposition = () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(whenCommitted);
        };
        surface?.addEventListener("compositionend", afterComposition);
        return () => {
          cancelAnimationFrame(frame);
          surface?.removeEventListener("compositionend", afterComposition);
        };
      }
      showReading();
      return;
    }
    const frame = requestAnimationFrame(() => {
      const surface = canvas.current;
      if (!surface) return;
      const block = citation.block ? renderedBlock(surface, citation.block) : undefined;
      const from =
        citation.from !== undefined &&
        citation.revision === snapshot.revision &&
        reading.source === snapshot.markdown
          ? blockAtOffset(analysis.blocks, citation.from)
          : undefined;
      const target =
        destination === "outline"
          ? toolPane.current
          : (block ??
            (from && renderedBlock(surface, from.id)) ??
            surface.querySelector("article"));
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: destination || from || block ? "center" : "start" });
      handledCitation.current = { citation, entry: citationEntry };
    });
    return () => cancelAnimationFrame(frame);
  }, [
    citation,
    citationEntry,
    returnVisit,
    analysis.blocks,
    snapshot.revision,
    snapshot.markdown,
    reading.source,
    tool,
    mode,
    leaveEditor,
    body,
  ]);

  useEffect(() => {
    const column = canvas.current;
    const grid = column?.parentElement;
    const page = grid?.closest<HTMLElement>(`.${styles.page}`);
    const surface = column?.querySelector<HTMLElement>(`.${styles.paper}`);
    const article = surface?.querySelector("article");
    if (!writable || restoringVersion || !page || !surface) return;
    const handlePaper = (event: MouseEvent) => {
      const pressing = event.type === "mousedown";
      if (pressing && (article || body.editor.isComposing())) return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        target.closest("a, button, input, textarea, select, img, [contenteditable='false']") ||
        !window.getSelection()?.isCollapsed
      )
        return;
      if (!surface.contains(target)) {
        // Only the document background is writable outside the body.
        if (
          target !== page &&
          target !== grid &&
          target !== column &&
          target !== toolbar.current &&
          !target.matches(`.${styles.title}`)
        )
          return;
        const pane = toolPane.current;
        if (
          pane &&
          !pane.hidden &&
          getComputedStyle(pane).getPropertyValue("--inline-tool").trim() === "0" &&
          event.clientX >= pane.getBoundingClientRect().left
        )
          return;
      }
      if (pressing) {
        // Keep both native focus and the editor selection in place until the click.
        if (body.editor.isBelowLastLine(event.clientY)) event.preventDefault();
        return;
      }
      const caret = textCaretAtClick(page, event);
      if (caret && !surface.contains(caret.node)) return;
      if (article) {
        const hit = readingPositionAtClick(article, event, reading.source, analysis, caret);
        enterEditor("preview", hit.position, hit.anchor);
      } else if (!caret && !body.editor.isComposing()) {
        body.editor.placeCaretAtPaperPoint(event.clientX, event.clientY, page.closest("main"));
      }
    };
    page.addEventListener("mousedown", handlePaper, true);
    page.addEventListener("click", handlePaper);
    return () => {
      page.removeEventListener("mousedown", handlePaper, true);
      page.removeEventListener("click", handlePaper);
    };
  }, [analysis, body, enterEditor, mode, reading.source, restoringVersion, writable]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        body.editor.isComposing() ||
        (event.target instanceof Element &&
          event.target.closest(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          ))
      )
        return;
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
        {citation?.revision && sourceRevision && citation.revision !== sourceRevision && (
          <Feedback tone="status" className={styles.citationNotice}>
            {citation.outline
              ? "引用时的提纲已更新，当前显示最新版本。"
              : "引用时的正文已更新，当前显示最新版本。"}
          </Feedback>
        )}
        {missingCitedOutline && (
          <Feedback tone="status" className={styles.citationNotice}>
            引用的提纲已移除。
          </Feedback>
        )}
        {!tool && (
          <Button
            ref={openToolButton}
            aria-label="打开文档辅助区"
            aria-controls={paneId}
            aria-expanded={false}
            onPressStart={rememberReadingSelection}
            onPress={() => setTool(rememberedTab)}
            className={styles.toolButton}
          >
            <Icon name="panel-right" />
            <span className={styles.toolLabel}>工具</span>
          </Button>
        )}
        {(writable || semantic.length > 0 || analysis.headings.length > 0) && (
          <ActionMenu
            label="文档更多"
            popoverClassName={styles.menu}
            trigger={
              <Button
                ref={moreButton}
                isIconOnly
                aria-label="文档更多"
                className={styles.iconButton}
                isDisabled={restoringVersion}
              >
                <Icon name="ellipsis" />
              </Button>
            }
            items={[
              ...(mode === "read" && analysis.headings.length
                ? [{ id: "contents", label: "文档目录", run: () => setTool("contents") }]
                : []),
              ...(writable
                ? [
                    {
                      id: "source",
                      label: mode === "source" ? "即时预览" : "完整源码",
                      run: () => enterEditor(mode === "source" ? "preview" : "source"),
                    },
                    { id: "metadata", label: "文档属性", run: () => setTool("metadata") },
                    {
                      id: "image",
                      label: "插入图片…",
                      run: () => {
                        if (mode === "read") enterEditor("preview");
                        setImageDialogOpen(true);
                      },
                    },
                    {
                      id: "static-reading",
                      label: "低 JS 阅读",
                      run: () => {
                        window.open(
                          `/workspaces/${encodeURIComponent(workspace)}/documents/${encodeURIComponent(documentId)}/read`,
                          "_blank",
                          "noopener",
                        );
                      },
                    },
                  ]
                : []),
              ...(renameDocument
                ? [
                    {
                      id: "rename",
                      label: "重命名…",
                      run: () => {
                        if (moreButton.current)
                          renameDocument(snapshot.document, moreButton.current);
                      },
                    },
                  ]
                : []),
              ...(writable && !outlineEnabled && (!showOutline || missingCitedOutline)
                ? [
                    {
                      id: "outline",
                      label: "添加提纲",
                      run: () => {
                        setOutlineRequested(true);
                        setTool("outline");
                      },
                    },
                  ]
                : []),
              ...(mode === "read" && semantic.length
                ? [{ id: "semantic", label: "聚焦此处", run: () => moveSemantic(0) }]
                : []),
            ]}
          />
        )}
      </div>
      <div className={styles.documentGrid} data-tool={tool} data-reading-grid>
        <DocumentToolPanel
          ref={toolPane}
          id={paneId}
          tool={tool}
          rememberedTab={rememberedTab}
          onSelect={setTool}
          onClose={() => {
            savedSelection.current = undefined;
            savedEditorSelection.current = undefined;
            setTool(undefined);
          }}
          outline={
            showOutline ? (
              <>
                {outlineSnapshot && !missingCitedOutline && (
                  <OutlineCanvas
                    snapshot={outlineSnapshot}
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
                  <Feedback tone="error" className={styles.sideError}>
                    无法打开提纲
                  </Feedback>
                )}
                {outline.isPending && (
                  <Feedback tone="status" className={styles.sideError}>
                    正在打开提纲…
                  </Feedback>
                )}
              </>
            ) : undefined
          }
          history={
            <VersionPanel
              workspace={workspace}
              documentId={documentId}
              writable={writable}
              onRestore={restore}
            />
          }
          references={<DocumentReferencesPanel workspace={workspace} document={documentId} />}
          contents={
            <DocumentContents
              headings={analysis.headings}
              initial={contentsInitial}
              onChoose={(id) => {
                const target = window.document.getElementById(id);
                if (!target) return;
                target.tabIndex = -1;
                if (
                  toolPane.current &&
                  getComputedStyle(toolPane.current).getPropertyValue("--inline-tool").trim() ===
                    "1"
                ) {
                  contentsDestination.current = target;
                  setTool(undefined);
                } else {
                  target.focus({ preventScroll: true });
                  target.scrollIntoView({ block: "start" });
                }
              }}
            />
          }
          metadata={
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
          }
        />
        <div
          className={styles.canvas}
          data-editable={writable || undefined}
          data-reading-measure
          ref={canvas}
        >
          {!titleIsFirstHeading && <h1 className={styles.title}>{title}</h1>}
          {mode === "read" ? (
            <div className={styles.paper}>
              <ReaderSurface
                analysis={analysis}
                label={title}
                activeBlocks={selectedBlock?.ids}
                onKeyDown={readerShortcut}
                resolveLink={resolveLink}
                resolveImage={resolveImage}
              />
            </div>
          ) : (
            <div className={styles.paper} ref={mountBody} />
          )}
        </div>
      </div>
      <DocumentAiPanel open={aiOpen} onClose={closeAi}>
        <AiPanel
          key={location.state.__TSR_key}
          citationDraft={citationDraft}
          floating
          active={aiOpen}
          workspace={workspace}
          documentId={documentId}
          documents={documents ?? []}
          writable={writable}
          resolveContext={resolveAiContext}
          returnVisit={returnVisit?.transcript}
          onSourceVisit={rememberSource}
        />
      </DocumentAiPanel>
      {!aiOpen && (
        <Button
          ref={aiLauncher}
          className={styles.aiLauncher}
          isIconOnly
          aria-label="打开文档 AI"
          onPress={openAi}
        >
          <Icon name="sparkles" />
        </Button>
      )}
      {mode === "read" && selectedBlock && (
        <fieldset className={styles.semanticControls} aria-label="语义聚焦">
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
        </fieldset>
      )}
      {imageNotice && (
        <NotificationPortal>
          <Feedback
            tone={imageNotice.tone}
            className={imageNotice.tone === "error" ? styles.saveError : styles.saved}
          >
            {imageNotice.text}
          </Feedback>
        </NotificationPortal>
      )}
      {imageDialogOpen && (
        <ImageInsertDialog
          documentPath={path}
          busy={imageBusy}
          onClose={closeImageDialog}
          onInsert={insertImagesFromDialog}
        />
      )}
      <SaveNotice
        saves={body.saves}
        editor={body.editor}
        kind="body"
        onResolved={continueAfterSaveConflict}
      />
      {outlineSession && (
        <SaveNotice
          saves={outlineSession.saves}
          editor={outlineSession.editor}
          kind="outline"
          onResolved={() => outlineSession.editor.focus()}
        />
      )}
    </div>
  );
}
