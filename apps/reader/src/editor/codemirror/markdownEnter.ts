import { isolateHistory } from "@codemirror/commands";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { TransactionSpec } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { EditorView } from "@codemirror/view";
import { frontMatterRange } from "./syntax";

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
const enter: TransactionSpec = {
  userEvent: "input",
  annotations: isolateHistory.of("full"),
  scrollIntoView: true,
};

export function markdownEnter(view: EditorView): boolean {
  const { state } = view;
  const cursor = state.selection.main;
  if (state.readOnly || view.compositionStarted || !cursor.empty) return false;

  const pos = cursor.head;
  const line = state.doc.lineAt(pos);
  const metadata = frontMatterRange(state.doc);
  if (metadata && pos <= metadata.to) return false;

  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  const endQuote = />[ \t]*$/.exec(line.text);
  if (endQuote && pos > line.from + endQuote.index) {
    const mark = tree.resolveInner(line.from + endQuote.index + 1, -1);
    if (mark.name === "QuoteMark" && mark.parent?.name === "Blockquote") {
      const from = mark.parent.parent?.name === "Document" ? line.from : mark.from;
      view.dispatch({ ...enter, changes: { from, to: line.to }, selection: { anchor: from } });
      return true;
    }
  }

  // Use the language command for indentation, nested outdents and ordered sibling numbering.
  let item: SyntaxNode | undefined;
  for (let parent: typeof node | null = node; parent; parent = parent.parent) {
    if (parent.name === "FencedCode" || parent.name === "CodeBlock") return false;
    if (parent.name === "ListItem") {
      item = parent;
      break;
    }
  }
  const marker = item?.getChild("ListMark");
  const firstLine = marker && marker.from >= line.from && pos >= marker.to;
  const suffix = firstLine ? state.sliceDoc(marker.to, line.to) : undefined;
  const empty =
    suffix !== undefined &&
    /^(?:[ \t]+\[[ xX]\])?[ \t]*$/.test(suffix) &&
    !state.sliceDoc(pos, line.to).trim();
  const task = item?.getChild("Task")?.getChild("TaskMarker");
  const continueOrderedTask =
    firstLine && !empty && item?.parent?.name === "OrderedList" && task && pos >= task.to;

  // The language command recognizes a blank list item by its marker and spacing.
  // Plan checkbox-only and bare markers as that same item, then dispatch one edit.
  const steps: TransactionSpec[] = [];
  let context = state;
  if (marker && empty && (suffix !== " " || pos !== line.to)) {
    const blank = {
      changes: { from: marker.to, to: line.to, insert: " " },
      selection: { anchor: marker.to + 1 },
    };
    context = state.update({ ...blank, filter: false }).state;
    steps.push(blank);
  }
  return continueMarkup({
    state: context,
    dispatch(transaction) {
      steps.push({
        sequential: true,
        changes: transaction.changes,
        selection: transaction.newSelection,
      });
      if (continueOrderedTask) {
        const at = transaction.newSelection.main.head;
        steps.push({
          sequential: true,
          changes: { from: at, insert: "[ ] " },
          selection: { anchor: at + 4 },
        });
      }
      view.dispatch(...steps, enter);
    },
  });
}
