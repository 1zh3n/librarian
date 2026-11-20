import type { EditorState, Text } from "@codemirror/state";

export function frontMatterRange(doc: Text): { from: number; to: number } | undefined {
  if (!/^\uFEFF?---[\t ]*$/.test(doc.line(1).text)) {
    return;
  }
  for (let i = 2; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^(?:---|\.\.\.)[\t ]*$/.test(line.text)) {
      return { from: 0, to: line.to };
    }
  }
}

export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}
