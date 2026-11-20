import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, MapMode, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { applyTextEdits, editorOffset, editorText, originalOffset, readSource } from "../document";
import type { SourceDocument, TextEdit } from "../document";

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

export interface EditorSession {
  source(): string;
  applyChanges(changes: readonly TextEdit[]): void;
  mount(parent: HTMLElement): () => void;
}

export function openEditor(initial: string): EditorSession {
  const source = readSource(initial);
  let state = EditorState.create({
    doc: editorText(initial),
    extensions: [
      sourceField.init(() => source),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Markdown 正文" }),
    ],
  });
  let view: EditorView | undefined;

  return {
    source: () => state.field(sourceField).value,
    applyChanges(edits) {
      const before = state.field(sourceField);
      const next = applyTextEdits(before.value, edits);
      if (next === before.value) {
        return;
      }
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
      const transaction = state.update({ changes, effects: replaceSource.of(after) });
      if (view) {
        view.dispatch(transaction);
      } else {
        state = transaction.state;
      }
    },
    mount(parent) {
      if (view) {
        throw new Error("The editor is already mounted");
      }
      const mounted = new EditorView({
        state,
        parent,
        dispatchTransactions(transactions, editor) {
          editor.update(transactions);
          state = editor.state;
        },
      });
      view = mounted;
      mounted.focus();
      return () => {
        mounted.destroy();
        if (view === mounted) {
          view = undefined;
        }
      };
    },
  };
}
