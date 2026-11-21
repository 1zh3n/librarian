import { syntaxTree } from "@codemirror/language";
import { Facet, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { Decoration, EditorView } from "@codemirror/view";
import { blockEndMargin, blockGap, headingSizes } from "../../markdown/paperSpacing";
import { composing } from "./composition";
import { frontMatterRange } from "./syntax";

const leadLine = Decoration.line({ attributes: { "data-preview-lead": "" } });
const quotePrefix = Decoration.mark({ attributes: { "data-quote-prefix": "" } });

function quoteTypography(state: EditorState, node: SyntaxNode, ranges: Range<Decoration>[]) {
  const first = state.doc.lineAt(node.from).number;
  const last = state.doc.lineAt(node.to).number;
  const depths = new Int32Array(last - first + 2);
  node.cursor().iterate((child) => {
    if (child.name === "Blockquote") {
      const start = state.doc.lineAt(child.from).number - first;
      const end = state.doc.lineAt(child.to).number - first + 1;
      depths[start] = depths[start]! + 1;
      depths[end] = depths[end]! - 1;
    }
  });
  let depth = 0;
  for (let i = first; i <= last; i++) {
    const line = state.doc.line(i);
    depth += depths[i - first]!;
    ranges.push(
      Decoration.line({
        attributes: {
          "data-preview-quote": "paper",
          style: `--quote-depth: ${depth}`,
        },
      }).range(line.from),
    );
    let prefix = 0;
    for (let level = 0; level < depth; level++) {
      const mark = /^ {0,3}>[ \t]?/.exec(line.text.slice(prefix));
      if (!mark) break;
      prefix += mark[0].length;
    }
    if (prefix) ranges.push(quotePrefix.range(line.from, line.from + prefix));
  }
}

function documentTypography(state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  const metadata = frontMatterRange(state.doc);
  let previousLine = 0;
  let previousEndMargin = "0px";
  let previousQuote = false;
  const tree = syntaxTree(state);
  let blocks = 0;
  let firstWasTitle = false;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (metadata && node.from < metadata.to) continue;
    const first = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to);
    if (node.name === "Blockquote") quoteTypography(state, node, ranges);
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    const headingSize = heading ? headingSizes[Number(heading[1]) - 1] : undefined;
    const lead = node.name === "Paragraph" && (blocks === 0 || (blocks === 1 && firstWasTitle));
    if (lead) {
      for (let i = first.number; i <= last.number; i++)
        ranges.push(leadLine.range(state.doc.line(i).from));
    }
    if (blocks > 0) {
      // The first separating line absorbs the collapsed block margin. All other
      // blank source lines keep their native height, including at either end.
      const hasBlank = previousLine + 1 < first.number;
      const adjacentQuote = !hasBlank && (previousQuote || node.name === "Blockquote");
      const gap = blockGap(previousEndMargin, headingSize, adjacentQuote);
      const firstGapLine = hasBlank ? state.doc.line(previousLine + 1) : first;
      const style = hasBlank ? `min-height: max(1lh, ${gap})` : `padding-block-start: ${gap}`;
      ranges.push(Decoration.line({ attributes: { style } }).range(firstGapLine.from));
    }
    previousEndMargin = blockEndMargin(headingSize, lead, node.name === "Table");
    previousQuote = node.name === "Blockquote";
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
  "&[data-document-preview] .cm-line[data-preview-quote='paper']": {
    "--quote-step": "calc(1em + 2px)",
    "--quote-inset": "calc(var(--quote-depth) * var(--quote-step))",
    color: "var(--ink-secondary)",
    borderInlineStart: "0",
    paddingInlineStart: "var(--quote-inset)",
    backgroundImage:
      "repeating-linear-gradient(to right, var(--muted-accent) 0 2px, transparent 2px var(--quote-step))",
    backgroundSize: "var(--quote-inset) 100%",
    backgroundRepeat: "no-repeat",
  },
  "&[data-document-preview] [data-quote-prefix]": {
    display: "inline-block",
    width: "var(--quote-inset)",
    marginInlineStart: "calc(-1 * var(--quote-inset))",
    textAlign: "end",
    whiteSpace: "pre",
    color: "transparent",
  },
  "&[data-document-preview] [data-preview-caret] [data-quote-prefix]": {
    color: "var(--ink-secondary)",
  },
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
