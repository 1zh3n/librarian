import { syntaxTree } from "@codemirror/language";
import { Facet, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { composing } from "./composition";
import { frontMatterRange } from "./syntax";

// Block margins in the reading canvas collapse. A visible Markdown separator
// occupies that same space even if the author used several blank source lines.
const bodySize = "var(--reading-size)";
const headingSizes = [
  "var(--reading-title-size)",
  ...[1.45, 1.17, 1, 0.83, 0.67].map((scale) => `calc(${bodySize} * ${scale})`),
];
const leadLine = Decoration.line({ attributes: { "data-preview-lead": "" } });

function documentTypography(state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  const metadata = frontMatterRange(state.doc);
  let previousLine = metadata ? state.doc.lineAt(metadata.to).number : 0;
  let previousEndMargin = "0px";
  const tree = syntaxTree(state);
  let blocks = 0;
  let firstWasTitle = false;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (metadata && node.from < metadata.to) continue;
    const first = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to);
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    const headingSize = heading && headingSizes[Number(heading[1]) - 1];
    const lead = node.name === "Paragraph" && (blocks === 0 || (blocks === 1 && firstWasTitle));
    if (lead) {
      for (let i = first.number; i <= last.number; i++)
        ranges.push(leadLine.range(state.doc.line(i).from));
    }
    const before = headingSize && blocks > 0 ? `calc(${headingSize} * 1.7)` : "0px";
    const gap = `max(${previousEndMargin}, ${before})`;
    const blanks = first.number - previousLine - 1;
    if (blanks > 0) {
      addBlankLines(previousLine + 1, blanks, gap);
    } else if (blocks > 0) {
      ranges.push(
        Decoration.line({ attributes: { style: `padding-block-start: ${gap}` } }).range(first.from),
      );
    }
    previousEndMargin = headingSize
      ? `calc(${headingSize} * .45)`
      : lead
        ? `calc(${bodySize} * 1.075 * 1.45)`
        : bodySize;
    // Reading tables live in a scroll container with no outer paragraph margin.
    if (node.name === "Table") previousEndMargin = "0px";
    previousLine = last.number;
    if (blocks === 0) firstWasTitle = heading?.[1] === "1";
    blocks++;
  }
  const complete = blocks > 0 && tree.length === state.doc.length;
  const end = complete ? state.doc.line(previousLine).to : state.doc.length;
  return {
    ranges: Decoration.set(ranges, true),
    endMargin: complete ? previousEndMargin : "0px",
    endOfText: /^[\n\t ]*$/.test(state.sliceDoc(end)) ? end : state.doc.length,
  };

  function addBlankLines(first: number, count: number, gap: string) {
    const separator = Decoration.line({
      attributes: { "data-preview-blank": "", style: `--preview-gap: calc(${gap} / ${count})` },
    });
    for (let line = first; line < first + count; line++)
      ranges.push(separator.range(state.doc.line(line).from));
  }
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
  "&[data-document-preview] [data-preview-blank]": {
    height: "var(--preview-gap)",
    lineHeight: "0",
    overflow: "hidden",
  },
  "&[data-document-preview] [data-preview-blank][data-preview-caret]": {
    minHeight: "1lh",
    lineHeight: "inherit",
    overflow: "visible",
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
    if (state.field(composing))
      return {
        ...value,
        ranges: value.ranges.map(transaction.changes),
        endOfText: transaction.changes.mapPos(value.endOfText),
      };
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
  EditorView.decorations.compute([typography, "selection", composing], (state) => {
    const { endOfText } = state.field(typography);
    if (
      state.field(composing) ||
      endOfText === state.doc.length ||
      state.selection.ranges.some((range) => range.to > endOfText)
    )
      return Decoration.none;
    // A replacement gives off-screen line breaks their real preview height.
    // Entering the trailing whitespace exposes its original source lines.
    return Decoration.set([Decoration.replace({}).range(endOfText, state.doc.length)]);
  }),
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
