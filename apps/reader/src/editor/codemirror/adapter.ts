import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  Text,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { applyTextEdits, editorOffset, editorText, originalOffset, readSource } from "../document";
import type { SourceDocument, TextEdit } from "../document";
import { anchorSampleInset, blockAtOffset, resolveAnchor } from "../../markdown/anchors";
import type { ScrollAnchor } from "../../markdown/anchors";
import type { Block } from "../../markdown/blocks";
import { composing, compositionEvents, setComposing } from "./composition";
import { livePreview } from "./livePreview";
import { frontMatterRange } from "./syntax";

const replaceSource = StateEffect.define<SourceDocument>();

const sourceField = StateField.define<SourceDocument>({
  create(state) {
    return readSource(state.doc.toString());
  },
  update(source, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(replaceSource)) {
        return effect.value;
      }
    }
    if (!transaction.docChanged) {
      return source;
    }

    const edits: TextEdit[] = [];
    transaction.changes.iterChanges((from, to, _start, _end, inserted) => {
      edits.push({
        from: originalOffset(source, from),
        to: originalOffset(source, to),
        insert: inserted.toString(),
      });
    });

    const crlf = source.crlf.flatMap((offset) => {
      const mapped = transaction.changes.mapPos(offset, 1, MapMode.TrackAfter);
      return mapped === null ? [] : [mapped];
    });
    return { value: applyTextEdits(source.value, edits), crlf };
  },
});

function minimalChange(before: string, after: string): TextEdit[] {
  let from = 0;
  while (from < before.length && before[from] === after[from]) {
    from++;
  }
  let to = before.length;
  let insertTo = after.length;
  while (to > from && insertTo > from && before[to - 1] === after[insertTo - 1]) {
    to--;
    insertTo--;
  }
  return from === to && from === insertTo
    ? []
    : [{ from, to, insert: after.slice(from, insertTo) }];
}

export interface ExternalPatch {
  readonly baseRevision: string;
  readonly revision: string;
  readonly edits: readonly TextEdit[];
}

type ExternalResult = "applied" | "conflict";
type SourceSelection = { readonly anchor: number; readonly head: number };
type EditorOptions = {
  readonly revision?: string;
  readonly selection?: SourceSelection;
  readonly onDeferredExternalResult?: (revision: string, result: ExternalResult) => void;
};

export interface EditorSession {
  source(): string;
  selection(): SourceSelection;
  applyExternal(change: ExternalPatch): ExternalResult | "deferred";
  applyChanges(changes: readonly TextEdit[]): void;
  setSourceMode(enabled: boolean): boolean;
  captureAnchor(viewport: HTMLElement, blocks: readonly Block[]): ScrollAnchor | undefined;
  restoreAnchor(
    viewport: HTMLElement,
    blocks: readonly Block[],
    anchor: ScrollAnchor,
  ): Promise<boolean>;
  mount(parent: HTMLElement): () => void;
}

export function openEditor(initial: string, options: EditorOptions = {}): EditorSession {
  const source = readSource(initial);
  const doc = Text.of(editorText(initial).split("\n"));
  const metadata = frontMatterRange(doc);
  const preview = new Compartment();
  const undoHistory = new Compartment();
  const selection = options.selection;
  let revision = options.revision;
  let confirmedSource = initial;
  let pendingExternal: ExternalPatch | undefined;
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
      undoHistory.of(history()),
      markdown({ extensions: GFM, completeHTMLTags: false }),
      composing,
      compositionEvents,
      preview.of(livePreview),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Markdown 正文" }),
    ],
  });
  let view: EditorView | undefined;

  function dispatch(transaction: Transaction) {
    if (view) {
      view.dispatch(transaction);
    } else {
      state = transaction.state;
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
        annotations: Transaction.addToHistory.of(!external),
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

  return {
    source: () => state.field(sourceField).value,
    selection() {
      const { anchor, head } = state.selection.main;
      const current = state.field(sourceField);
      return { anchor: originalOffset(current, anchor), head: originalOffset(current, head) };
    },
    applyChanges(edits) {
      applyEdits(edits, false);
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
        effects: preview.reconfigure(enabled ? [] : livePreview),
      });
      if (view) {
        view.dispatch(transaction);
        view.focus();
      } else {
        state = transaction.state;
      }
      return true;
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
    async restoreAnchor(viewport, blocks, anchor) {
      const mounted = view;
      const block = resolveAnchor(blocks, anchor, true);
      if (!mounted || !block) return false;
      const at = editorOffset(state.field(sourceField), block.from);
      mounted.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 0 }),
      });
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (view !== mounted) return false;
        const inset =
          mounted.documentTop + mounted.lineBlockAt(at).top - viewport.getBoundingClientRect().top;
        viewport.scrollTop += inset - anchor.insetPx;
      }
      return true;
    },
    mount(parent) {
      if (view) {
        throw new Error("The editor is already mounted");
      }
      const mounted = new EditorView({
        state,
        parent,
        dispatchTransactions(transactions, editor) {
          const wasComposing = state.field(composing);
          editor.update(transactions);
          state = editor.state;
          if (wasComposing && !state.field(composing) && pendingExternal) {
            queueMicrotask(settleDeferred);
          }
        },
      });
      view = mounted;
      mounted.focus();
      return () => {
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
