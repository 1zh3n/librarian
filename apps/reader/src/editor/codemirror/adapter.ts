import { forceParsing } from "@codemirror/language";
import { deleteMarkupBackward, markdown } from "@codemirror/lang-markdown";
import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
  isolateHistory,
} from "@codemirror/commands";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Text,
  Transaction,
} from "@codemirror/state";
import type { ChangeSet } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import {
  applyTextEdits,
  editorOffset,
  editorText,
  minimalChange,
  originalLineEndings,
  originalOffset,
  readSource,
} from "../document";
import type { SourceDocument, TextEdit } from "../document";
import { anchorSampleInset, blockAtOffset, resolveAnchor } from "../../markdown/anchors";
import type { AnchorPlacement, ScrollAnchor } from "../../markdown/anchors";
import type { Block } from "../../markdown/blocks";
import { composing, compositionEvents, setComposing } from "./composition";
import {
  documentPreviewTypography,
  hideFrontMatterControl,
  imagePreview,
  livePreview,
} from "./livePreview";
import type { ImageResolver } from "./livePreview";
import { paperScrollAnchor } from "./paperScrollAnchor";
import { markdownEnter } from "./markdownEnter";
import { frontMatterRange } from "./syntax";

function imageFiles(files: FileList | null | undefined) {
  return Array.from(files ?? []).filter(
    (file) => file.type.startsWith("image/") || /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(file.name),
  );
}

const replaceSource = StateEffect.define<SourceDocument>();
const restoreLineEndings = StateEffect.define<readonly TextEdit[]>();
const editorFocus = EditorView.theme({
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    paddingInline: "var(--document-editor-gutter, 0px)",
    paddingBlockEnd: "var(--document-editor-endspace, 4px)",
  },
  ".cm-content:focus-visible": { outline: "none" },
});

function projectSource(source: SourceDocument, changes: ChangeSet): SourceDocument {
  const edits: TextEdit[] = [];
  changes.iterChanges((from, to, _start, _end, inserted) => {
    edits.push({
      from: originalOffset(source, from),
      to: originalOffset(source, to),
      insert: inserted.toString(),
    });
  });
  return readSource(applyTextEdits(source.value, edits));
}

const sourceField = StateField.define<SourceDocument>({
  create(state) {
    return readSource(state.doc.toString());
  },
  update(source, transaction) {
    // Grouped undo stores inverse effects in reverse edit order. The last
    // snapshot describes the same document as the composed inverse changes.
    for (let index = transaction.effects.length - 1; index >= 0; index--) {
      const effect = transaction.effects[index]!;
      if (effect.is(replaceSource)) return effect.value;
      if (effect.is(restoreLineEndings)) {
        return readSource(applyTextEdits(transaction.newDoc.toString(), effect.value));
      }
    }
    return transaction.docChanged ? projectSource(source, transaction.changes) : source;
  },
});

const sourceHistory = invertedEffects.of((transaction) => {
  if (
    !transaction.docChanged &&
    !transaction.effects.some((effect) => effect.is(replaceSource) || effect.is(restoreLineEndings))
  ) {
    return [];
  }
  return [
    restoreLineEndings.of(originalLineEndings(transaction.startState.field(sourceField).value)),
  ];
});

const reconcileLineEndings = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || transaction.effects.some((effect) => effect.is(replaceSource))) {
    return transaction;
  }
  const before = transaction.startState.field(sourceField);
  if (!before.value.includes("\r")) return transaction;

  const after = projectSource(before, transaction.changes);
  const expected = editorText(after.value);
  return [
    transaction,
    {
      sequential: true,
      changes: minimalChange(transaction.newDoc.toString(), expected),
      effects: replaceSource.of(after),
    },
  ];
});

export interface ExternalPatch {
  readonly baseRevision: string | null;
  readonly revision: string | null;
  readonly edits: readonly TextEdit[];
}

type ExternalResult = "applied" | "conflict";
type SourceSelection = { readonly anchor: number; readonly head: number };
type EditorOptions = {
  readonly revision?: string | null;
  readonly selection?: SourceSelection;
  readonly readOnly?: boolean;
  readonly ariaLabel?: string;
  readonly hideMetadataInPreview?: boolean;
  readonly documentTypography?: boolean;
  readonly resolveImage?: ImageResolver | undefined;
  readonly onImageFiles?: ((files: File[], at?: number) => void) | undefined;
  readonly onDeferredExternalResult?: (revision: string | null, result: ExternalResult) => void;
  readonly onBufferChange?: (source: string, composing: boolean) => void;
};

export interface EditorMountAnchor {
  readonly viewport: HTMLElement;
  readonly sourceOffset: number;
  readonly screenTop: number;
  /** The side of a caret that supplied the clicked glyph, including at a soft wrap. */
  readonly glyphSide?: 1 | -1;
  readonly keepCaretVisible?: boolean;
}

export interface EditorSession {
  source(): string;
  selection(): SourceSelection;
  select(selection: SourceSelection): void;
  focus(): void;
  isComposing(): boolean;
  acknowledge(markdown: string, revision: string | null): void;
  resetSource(markdown: string, confirmed: string, revision: string | null): boolean;
  applyExternal(change: ExternalPatch): ExternalResult | "deferred";
  moveToFinalBlankLine(): void;
  isBelowLastLine(y: number): boolean;
  placeCaretAtPaperPoint(x: number, y: number, viewport?: HTMLElement | null): void;
  applyChanges(changes: readonly TextEdit[]): void;
  insertMarkdown(markdown: string, at?: number): void;
  setImageHandler(handler: ((files: File[], at?: number) => void) | undefined): void;
  setSourceMode(enabled: boolean): boolean;
  trackAnchor(anchor: ScrollAnchor | undefined): void;
  trackedAnchor(): AnchorPlacement | undefined;
  captureAnchor(viewport: HTMLElement, blocks: readonly Block[]): ScrollAnchor | undefined;
  restoreAnchor(
    viewport: HTMLElement,
    blocks: readonly Block[],
    anchor: ScrollAnchor,
    sameRevision: boolean,
    keepSelection?: boolean,
  ): Promise<boolean>;
  mount(parent: HTMLElement, autoFocus?: boolean, anchor?: EditorMountAnchor): () => void;
}

export function openEditor(initial: string, options: EditorOptions = {}): EditorSession {
  const source = readSource(initial);
  const doc = Text.of(editorText(initial).split("\n"));
  const metadata = frontMatterRange(doc);
  const imageExtension = options.resolveImage ? [imagePreview.of(options.resolveImage)] : [];
  const previewExtensions = options.documentTypography
    ? [livePreview, documentPreviewTypography, ...imageExtension]
    : [livePreview, ...imageExtension];
  const preview = new Compartment();
  const undoHistory = new Compartment();
  const paperAnchor = paperScrollAnchor();
  const selection = options.selection;
  let revision = options.revision;
  let confirmedSource = initial;
  let pendingExternal: ExternalPatch | undefined;
  let imageHandler = options.onImageFiles;
  let state = EditorState.create({
    doc,
    selection: selection
      ? {
          anchor: editorOffset(source, selection.anchor),
          head: editorOffset(source, selection.head),
        }
      : { anchor: metadata ? Math.min(metadata.to + 1, doc.length) : 0 },
    extensions: [
      sourceField.init(() => source),
      sourceHistory,
      reconcileLineEndings,
      undoHistory.of(history()),
      markdown({ extensions: GFM, completeHTMLTags: false, addKeymap: false }),
      composing,
      compositionEvents,
      preview.of(previewExtensions),
      hideFrontMatterControl.of(options.hideMetadataInPreview ?? false),
      editorFocus,
      paperAnchor.extension,
      keymap.of([
        { key: "Enter", run: markdownEnter },
        { key: "Backspace", run: deleteMarkupBackward },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(options.readOnly ?? false),
      EditorView.editable.of(!options.readOnly),
      EditorView.contentAttributes.of({ "aria-label": options.ariaLabel ?? "Markdown 正文" }),
      EditorView.domEventHandlers({
        paste(event) {
          const files = imageFiles(event.clipboardData?.files);
          if (!files.length || !imageHandler) return false;
          event.preventDefault();
          imageHandler(files);
          return true;
        },
        drop(event, view) {
          const files = imageFiles(event.dataTransfer?.files);
          if (!files.length || !imageHandler) return false;
          event.preventDefault();
          const position =
            view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
            view.state.selection.main.head;
          view.dispatch({ selection: { anchor: position } });
          const source = view.state.field(sourceField);
          imageHandler(files, originalOffset(source, position));
          return true;
        },
        dragover(event) {
          if (!imageHandler || !imageFiles(event.dataTransfer?.files).length) return false;
          event.preventDefault();
          return true;
        },
      }),
    ],
  });
  let view: EditorView | undefined;
  let tracked: { anchor: ScrollAnchor; position: number; source: string } | undefined;

  function record(transaction: Transaction) {
    const priorSource = state.field(sourceField).value;
    const priorComposition = state.field(composing);
    if (tracked && transaction.docChanged) {
      tracked.position = transaction.changes.mapPos(tracked.position);
    }
    state = transaction.state;
    if (transaction.annotation(Transaction.remote)) return;
    const markdown = state.field(sourceField).value;
    const active = state.field(composing);
    if (markdown !== priorSource || active !== priorComposition) {
      options.onBufferChange?.(markdown, active);
    }
  }

  function dispatch(transaction: Transaction) {
    if (view) {
      view.dispatch(transaction);
    } else {
      record(transaction);
    }
  }

  function applyEdits(edits: readonly TextEdit[], external: boolean) {
    const before = state.field(sourceField);
    const next = applyTextEdits(before.value, edits);
    if (next === before.value) return;

    const after = readSource(next);
    const normalized = editorText(next);
    const mappedEdits = edits.map(({ from, to, insert }) => ({
      from: editorOffset(before, from),
      to: editorOffset(before, to),
      insert: editorText(insert),
    }));
    let changes = state.changes(mappedEdits);
    if (changes.apply(state.doc).toString() !== normalized) {
      // Edits at a CRLF boundary can join or split a normalized line break.
      changes = state.changes(minimalChange(state.doc.toString(), normalized));
    }
    dispatch(
      state.update({
        changes,
        effects: external
          ? [replaceSource.of(after), undoHistory.reconfigure([])]
          : replaceSource.of(after),
        annotations: [Transaction.addToHistory.of(!external), Transaction.remote.of(external)],
      }),
    );
    if (external) dispatch(state.update({ effects: undoHistory.reconfigure(history()) }));
  }

  function applyCommitted(change: ExternalPatch): ExternalResult {
    if (change.baseRevision !== revision || state.field(sourceField).value !== confirmedSource) {
      return "conflict";
    }
    try {
      applyEdits(change.edits, true);
    } catch (error) {
      if (error instanceof RangeError) return "conflict";
      throw error;
    }
    confirmedSource = state.field(sourceField).value;
    revision = change.revision;
    return "applied";
  }

  function settleDeferred() {
    const change = pendingExternal;
    if (!change || state.field(composing)) return;
    pendingExternal = undefined;
    const result = applyCommitted(change);
    options.onDeferredExternalResult?.(change.revision, result);
  }

  function isBelowLastLine(y: number) {
    return !!view && y >= view.documentTop + view.lineBlockAt(state.doc.length).bottom;
  }

  function moveToFinalBlankLine(scrollIntoView = true) {
    if (state.readOnly || state.field(composing)) return;
    const end = state.doc.length;
    if (state.doc.lineAt(end).text.trim() === "") {
      dispatch(state.update({ selection: { anchor: end }, scrollIntoView }));
      return;
    }
    const current = state.field(sourceField).value;
    const ending = /(\r\n|[\r\n])[^\r\n]*$/u.exec(current)?.[1] ?? "\n";
    dispatch(
      state.update({
        changes: { from: end, insert: "\n" },
        selection: { anchor: end + 1 },
        effects: replaceSource.of(readSource(current + ending)),
        annotations: isolateHistory.of("full"),
        scrollIntoView,
      }),
    );
  }

  function insertMarkdown(markdown: string, at?: number) {
    if (!markdown || state.readOnly) return;
    const current = state.field(sourceField);
    const from = at === undefined ? state.selection.main.from : editorOffset(current, at);
    const to = at === undefined ? state.selection.main.to : from;
    const originalFrom = originalOffset(current, from);
    const originalTo = originalOffset(current, to);
    const before = current.value.slice(0, originalFrom);
    const after = current.value.slice(originalTo);
    const ending = current.value.includes("\r\n") ? "\r\n" : "\n";
    const block = markdown.replace(/\r\n?|\n/gu, ending);
    const prefix =
      before === "" || before.endsWith(ending + ending)
        ? ""
        : before.endsWith(ending)
          ? ending
          : ending + ending;
    const suffix =
      after === ""
        ? ending
        : after.startsWith(ending + ending)
          ? ""
          : after.startsWith(ending)
            ? ending
            : ending + ending;
    applyEdits([{ from: originalFrom, to: originalTo, insert: prefix + block + suffix }], false);
    const next = state.field(sourceField);
    const position = editorOffset(
      next,
      originalFrom + prefix.length + block.length + suffix.length,
    );
    dispatch(state.update({ selection: { anchor: position }, scrollIntoView: true }));
    focus();
  }

  return {
    source: () => state.field(sourceField).value,
    selection() {
      const { anchor, head } = state.selection.main;
      const current = state.field(sourceField);
      return { anchor: originalOffset(current, anchor), head: originalOffset(current, head) };
    },
    select({ anchor, head }) {
      const current = state.field(sourceField);
      dispatch(
        state.update({
          selection: { anchor: editorOffset(current, anchor), head: editorOffset(current, head) },
        }),
      );
    },
    isComposing: () => state.field(composing),
    focus: () => view?.focus(),
    acknowledge(markdown, savedRevision) {
      confirmedSource = markdown;
      revision = savedRevision;
    },
    resetSource(markdown, confirmed, savedRevision) {
      if (state.field(composing)) return false;
      const next = readSource(markdown);
      let changes = state.changes(minimalChange(state.doc.toString(), editorText(markdown)));
      dispatch(
        state.update({
          changes,
          effects: [replaceSource.of(next), undoHistory.reconfigure([])],
          annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
        }),
      );
      dispatch(state.update({ effects: undoHistory.reconfigure(history()) }));
      pendingExternal = undefined;
      confirmedSource = confirmed;
      revision = savedRevision;
      return true;
    },
    moveToFinalBlankLine,
    isBelowLastLine,
    placeCaretAtPaperPoint(x, y, viewport) {
      if (!view || state.readOnly || state.field(composing) || view.compositionStarted) return;
      const end = state.doc.length;
      if (isBelowLastLine(y)) {
        let line = state.doc.lineAt(end);
        while (line.number > 1 && !line.text.trim()) line = state.doc.line(line.number - 1);
        const glyph = viewport && view.coordsAtPos(line.to, -1);
        moveToFinalBlankLine(!glyph);
        if (viewport && glyph)
          paperAnchor.hold(view, {
            viewport,
            at: line.to,
            screenTop: glyph.top,
            glyphSide: -1,
            keepCaretVisible: true,
          });
      } else {
        const { pos, assoc } = view.posAndSideAtCoords({ x, y }, false);
        const hiddenMetadata =
          options.hideMetadataInPreview && preview.get(state) === previewExtensions
            ? frontMatterRange(state.doc)
            : undefined;
        if (hiddenMetadata && hiddenMetadata.to === end) {
          moveToFinalBlankLine();
        } else {
          const firstWritable = hiddenMetadata ? hiddenMetadata.to + 1 : 0;
          view.dispatch({
            selection: EditorSelection.cursor(Math.max(firstWritable, pos), assoc),
            scrollIntoView: true,
          });
        }
      }
      view.focus();
    },
    applyChanges(edits) {
      applyEdits(edits, false);
    },
    insertMarkdown,
    setImageHandler(handler) {
      imageHandler = handler;
    },
    applyExternal(change) {
      if (change.baseRevision !== revision || pendingExternal) return "conflict";
      if (state.field(composing)) {
        pendingExternal = change;
        return "deferred";
      }
      return applyCommitted(change);
    },
    setSourceMode(enabled) {
      if (state.field(composing)) {
        return false;
      }
      const transaction = state.update({
        effects: preview.reconfigure(enabled ? [] : previewExtensions),
      });
      dispatch(transaction);
      view?.focus();
      return true;
    },
    trackAnchor(anchor) {
      const current = state.field(sourceField);
      tracked = anchor
        ? {
            anchor,
            position: editorOffset(current, anchor.sourceOffset),
            source: current.value,
          }
        : undefined;
    },
    trackedAnchor() {
      if (!tracked) return;
      const current = state.field(sourceField);
      return {
        anchor: { ...tracked.anchor, sourceOffset: originalOffset(current, tracked.position) },
        sameRevision: tracked.source === current.value,
      };
    },
    captureAnchor(viewport, blocks) {
      if (!view || viewport.scrollTop === 0) return;
      const top = viewport.getBoundingClientRect().top;
      const sampled = view.lineBlockAtHeight(top + anchorSampleInset - view.documentTop);
      const source = state.field(sourceField);
      const block = blockAtOffset(blocks, originalOffset(source, sampled.from));
      if (block) {
        const start = view.lineBlockAt(editorOffset(source, block.from));
        return {
          blockId: block.id,
          sourceOffset: block.from,
          insetPx: view.documentTop + start.top - top,
        };
      }
    },
    async restoreAnchor(viewport, blocks, anchor, sameRevision, keepSelection = false) {
      const mounted = view;
      const block = resolveAnchor(blocks, anchor, sameRevision);
      if (!mounted || !block) return false;
      const at = editorOffset(state.field(sourceField), block.from);
      mounted.dispatch({
        ...(!keepSelection && { selection: { anchor: at } }),
        effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 0 }),
      });
      const targetDoc = mounted.state.doc;
      const target = tracked?.anchor.blockId === anchor.blockId ? tracked : undefined;
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (view !== mounted || (target && tracked !== target)) return false;
        // Typing during layout maps the tracked offset through the edit.
        const position = mounted.state.doc === targetDoc ? at : target?.position;
        if (position === undefined) return false;
        const inset =
          mounted.documentTop +
          mounted.lineBlockAt(position).top -
          viewport.getBoundingClientRect().top;
        viewport.scrollTop += inset - anchor.insetPx;
      }
      return true;
    },
    mount(parent, autoFocus = true, anchor) {
      if (view) {
        throw new Error("The editor is already mounted");
      }
      const at = anchor && editorOffset(state.field(sourceField), anchor.sourceOffset);
      const mounted = new EditorView({
        state,
        ...(at !== undefined &&
          anchor && {
            scrollTo: EditorView.scrollIntoView(at, {
              y: "start",
              yMargin: anchor.screenTop - anchor.viewport.getBoundingClientRect().top,
            }),
          }),
        parent,
        dispatchTransactions(transactions, editor) {
          const wasComposing = state.field(composing);
          editor.update(transactions);
          for (const transaction of transactions) {
            record(transaction);
          }
          if (wasComposing && !state.field(composing) && pendingExternal) {
            queueMicrotask(settleDeferred);
          }
        },
      });
      view = mounted;
      if (autoFocus) mounted.focus();
      if (anchor && at !== undefined) {
        // Measure the target viewport and its preview decorations before the first paint.
        mounted.coordsAtPos(at);
        if (preview.get(state) === previewExtensions)
          forceParsing(mounted, mounted.viewport.to, 32);
        paperAnchor.hold(mounted, { ...anchor, at });
      }
      return () => {
        paperAnchor.release();
        mounted.destroy();
        if (view === mounted) {
          view = undefined;
          const unfinished = state.field(composing) && pendingExternal;
          state = state.update({ effects: setComposing.of(false) }).state;
          if (unfinished) {
            pendingExternal = undefined;
            options.onDeferredExternalResult?.(unfinished.revision, "conflict");
          }
        }
      };
    },
  };
}
