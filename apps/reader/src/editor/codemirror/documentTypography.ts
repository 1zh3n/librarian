import { syntaxTree } from "@codemirror/language";
import { Facet, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { blockEndMargin, headingSizes } from "../../markdown/paperSpacing";
import { composing } from "./composition";
import { frontMatterRange } from "./syntax";

const leadLine = Decoration.line({ attributes: { "data-preview-lead": "" } });

function documentTypography(state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  const metadata = frontMatterRange(state.doc);
  let previousLine = 0;
  let previousEndMargin = "0px";
  const tree = syntaxTree(state);
  let blocks = 0;
  let firstWasTitle = false;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (metadata && node.from < metadata.to) continue;
    const first = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to);
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    const headingSize = heading ? headingSizes[Number(heading[1]) - 1] : undefined;
    const lead = node.name === "Paragraph" && (blocks === 0 || (blocks === 1 && firstWasTitle));
    if (lead) {
      for (let i = first.number; i <= last.number; i++)
        ranges.push(leadLine.range(state.doc.line(i).from));
    }
    if (blocks > 0) {
      const before = headingSize ? `calc(${headingSize} * 1.7)` : "0px";
      const gap = `max(${previousEndMargin}, ${before})`;
      // The first separating line absorbs the collapsed block margin. All other
      // blank source lines keep their native height, including at either end.
      const hasBlank = previousLine + 1 < first.number;
      const firstGapLine = hasBlank ? state.doc.line(previousLine + 1) : first;
      const style = hasBlank ? `min-height: max(1lh, ${gap})` : `padding-block-start: ${gap}`;
      ranges.push(Decoration.line({ attributes: { style } }).range(firstGapLine.from));
    }
    previousEndMargin = blockEndMargin(headingSize, lead, node.name === "Table");
    previousLine = last.number;
    if (blocks === 0) firstWasTitle = heading?.[1] === "1";
    blocks++;
  }
  return {
    ranges: Decoration.set(ranges, true),
    endMargin: tree.length === state.doc.length ? previousEndMargin : "0px",
  };
}

const documentTypographyTheme = EditorView.baseTheme({
  "&[data-document-preview] .cm-content": {
    paddingBlockStart: "0",
    paddingBlockEnd: "calc(var(--document-editor-endspace, 4px) + var(--preview-end-margin))",
  },
  "&[data-document-preview] .cm-line": { paddingInline: "0" },
  "&[data-document-preview] [data-preview-lead]": {
    fontSize: "1.075em",
    lineHeight: "1.7",
    maxInlineSize: "38em",
    color: "var(--ink-secondary)",
  },
  "&[data-document-preview] [data-preview-heading]": { fontWeight: "700", lineHeight: "1.38" },
  ...Object.fromEntries(
    headingSizes.map((size, i) => [
      `&[data-document-preview] [data-preview-heading='${i + 1}']`,
      {
        fontSize: size,
        ...(i === 0 && { lineHeight: "1.16", letterSpacing: "-.035em", textWrap: "balance" }),
      },
    ]),
  ),
});

export const documentTypographyActive = Facet.define<boolean, boolean>({
  combine: (values) => values.includes(true),
});

const typography = StateField.define<ReturnType<typeof documentTypography>>({
  create: documentTypography,
  update(value, transaction) {
    const { state, startState } = transaction;
    if (state.field(composing)) return { ...value, ranges: value.ranges.map(transaction.changes) };
    return transaction.docChanged ||
      startState.field(composing) ||
      syntaxTree(state) !== syntaxTree(startState)
      ? documentTypography(state)
      : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.ranges),
    EditorView.editorAttributes.from(field, (value) => ({
      style: `--preview-end-margin: ${value.endMargin}`,
    })),
  ],
});

const caretLine = Decoration.line({ attributes: { "data-preview-caret": "" } });
export const documentPreviewTypography: Extension = [
  documentTypographyActive.of(true),
  typography,
  EditorView.decorations.compute(["selection", "doc"], (state) => {
    const lines = state.selection.ranges.map(({ head }) => state.doc.lineAt(head));
    return Decoration.set(
      lines.map((line) => caretLine.range(line.from)),
      true,
    );
  }),
  EditorView.editorAttributes.of({ "data-document-preview": "" }),
  documentTypographyTheme,
];
