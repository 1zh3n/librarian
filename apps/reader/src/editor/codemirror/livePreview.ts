import { syntaxTree } from "@codemirror/language";
import { StateField } from "@codemirror/state";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { toDom } from "hast-util-to-dom";
import { analyzeMarkdown } from "../../markdown/analyze";
import { composing } from "./composition";
import { frontMatterRange, selectionTouches } from "./syntax";

const hide = Decoration.replace({});

class MarkerWidget extends WidgetType {
  readonly text: string;
  readonly task: "checked" | "unchecked" | undefined;

  constructor(text: string, task?: "checked" | "unchecked") {
    super();
    this.text = text;
    this.task = task;
  }

  override eq(other: MarkerWidget): boolean {
    return other.text === this.text && other.task === this.task;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.textContent = this.text;
    if (this.task) {
      span.dataset.previewTask = this.task;
    } else {
      span.dataset.previewList = "";
    }
    return span;
  }
}

const formattedInline = new Map<string, readonly [string, string]>([
  ["Emphasis", ["em", "EmphasisMark"]],
  ["StrongEmphasis", ["strong", "EmphasisMark"]],
  ["Strikethrough", ["del", "StrikethroughMark"]],
  ["InlineCode", ["code", "CodeMark"]],
] as const);

function lineDecoration(attribute: string, name: string): Decoration {
  return Decoration.line({ attributes: { [attribute]: name } });
}

function conceal(ranges: Range<Decoration>[], state: EditorState, from: number, to: number) {
  if (from < to && state.doc.lineAt(from).number === state.doc.lineAt(to).number) {
    ranges.push(hide.range(from, to));
  }
}

function formatInline(ranges: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const { from, to, name } = node;
  const format = formattedInline.get(name);
  if (format && !selectionTouches(state, from, to)) {
    const [tag, marker] = format;
    const marks = node.getChildren(marker);
    const open = marks[0];
    const close = marks.at(-1);
    if (open && close && open.to < close.from) {
      conceal(ranges, state, open.from, open.to);
      conceal(ranges, state, close.from, close.to);
      ranges.push(Decoration.mark({ tagName: tag }).range(open.to, close.from));
    }
  }
  if (name === "Link" && !selectionTouches(state, from, to)) {
    const [open, close] = node.getChildren("LinkMark");
    if (
      open &&
      close &&
      open.to < close.from &&
      state.doc.lineAt(close.from).number === state.doc.lineAt(to).number
    ) {
      conceal(ranges, state, open.from, open.to);
      conceal(ranges, state, close.from, to);
      ranges.push(
        Decoration.mark({ attributes: { "data-preview-link": "" } }).range(open.to, close.from),
      );
    }
  }
}

function formatLine(ranges: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const { from, to, name } = node;
  const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  if (heading) {
    ranges.push(
      lineDecoration("data-preview-heading", heading[1] ?? "1").range(state.doc.lineAt(from).from),
    );
    if (!selectionTouches(state, from, to)) {
      for (const mark of node.getChildren("HeaderMark")) {
        const tail = state.sliceDoc(mark.to, state.doc.lineAt(mark.to).to);
        const gap = /^[\t ]*/.exec(tail)?.[0].length ?? 0;
        conceal(ranges, state, mark.from, mark.to + gap);
      }
    }
  }
  if (name === "QuoteMark") {
    ranges.push(lineDecoration("data-preview-quote", "").range(state.doc.lineAt(from).from));
    const next = state.sliceDoc(to, to + 1);
    if (!selectionTouches(state, from, state.doc.lineAt(from).to)) {
      conceal(ranges, state, from, to + (next === " " ? 1 : 0));
    }
  }
  if (
    name === "ListMark" &&
    node.parent &&
    !selectionTouches(state, node.parent.from, node.parent.to)
  ) {
    const marker = state.sliceDoc(from, to);
    const widget = new MarkerWidget(/^[-+*]$/.test(marker) ? "•" : marker);
    ranges.push(Decoration.replace({ widget }).range(from, to));
  }
  if (
    name === "TaskMarker" &&
    node.parent &&
    !selectionTouches(state, node.parent.from, node.parent.to)
  ) {
    const checked = /[xX]/.test(state.sliceDoc(from, to));
    const widget = new MarkerWidget(checked ? "☑" : "☐", checked ? "checked" : "unchecked");
    ranges.push(Decoration.replace({ widget }).range(from, to));
  }
}

function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  const frontMatter = frontMatterRange(state.doc);
  const visited = new Set<string>();
  const tree = syntaxTree(state);
  for (const visible of view.visibleRanges) {
    tree.iterate({
      ...visible,
      enter({ name, from, to, node }) {
        if (name === "Table" || (frontMatter && to <= frontMatter.to)) {
          return false;
        }
        const key = `${name}/${from}/${to}`;
        if (visited.has(key)) {
          return;
        }
        visited.add(key);
        if (name === "FencedCode" || name === "CodeBlock") {
          const begin = state.doc.lineAt(Math.max(from, visible.from)).number;
          const end = state.doc.lineAt(Math.min(to, visible.to)).number;
          for (let i = begin; i <= end; i++) {
            ranges.push(lineDecoration("data-preview-code", "").range(state.doc.line(i).from));
          }
          if (!selectionTouches(state, from, to)) {
            for (const marker of [
              ...node.getChildren("CodeMark"),
              ...node.getChildren("CodeInfo"),
            ]) {
              conceal(ranges, state, marker.from, marker.to);
            }
          }
          return false;
        }
        formatInline(ranges, state, node);
        formatLine(ranges, state, node);
      },
    });
  }
  return Decoration.set(ranges, true);
}

const previewInline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view);
    }

    update(update: ViewUpdate) {
      const { state, startState } = update;
      if (state.field(composing)) {
        this.decorations = this.decorations.map(update.changes);
      } else if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        startState.field(composing) ||
        syntaxTree(state) !== syntaxTree(startState)
      ) {
        this.decorations = inlineDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

class BlockWidget extends WidgetType {
  readonly kind: "table" | "frontmatter";
  readonly from: number;
  readonly source: string;

  constructor(kind: "table" | "frontmatter", from: number, source = "") {
    super();
    this.kind = kind;
    this.from = from;
    this.source = source;
  }

  override eq(other: BlockWidget): boolean {
    return other.kind === this.kind && other.from === this.from && other.source === this.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const wrapper = document.createElement("div");
    wrapper.dataset.previewBlock = this.kind;
    wrapper.contentEditable = "false";

    if (this.kind === "table") {
      const { tree } = analyzeMarkdown(this.source, "table-preview");
      wrapper.append(toDom(tree, { document, fragment: true }));
      const table = wrapper.querySelector("table");
      if (table) {
        table.tabIndex = 0;
      }
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Front Matter";
      wrapper.append(button);
    }

    const reveal = () => {
      if (!view.state.field(composing)) {
        view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
        view.focus();
      }
    };
    wrapper.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest("a")) {
        reveal();
      }
    });
    wrapper.addEventListener("keydown", (event) => {
      if (
        this.kind === "table" &&
        event.key === "Enter" &&
        !(event.target instanceof HTMLAnchorElement)
      ) {
        event.preventDefault();
        reveal();
      }
    });
    return wrapper;
  }
}

function blockDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const frontMatter = frontMatterRange(state.doc);
  if (frontMatter && !selectionTouches(state, frontMatter.from, frontMatter.to)) {
    const { from, to } = frontMatter;
    ranges.push(
      Decoration.replace({ block: true, widget: new BlockWidget("frontmatter", from) }).range(
        from,
        to,
      ),
    );
  }
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === "Table" && !selectionTouches(state, node.from, node.to)) {
      const { from, to } = node;
      ranges.push(
        Decoration.replace({
          block: true,
          widget: new BlockWidget("table", from, state.sliceDoc(from, to)),
        }).range(from, to),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const previewBlocks = StateField.define<DecorationSet>({
  create: blockDecorations,
  update(ranges, transaction) {
    if (transaction.state.field(composing)) {
      return ranges.map(transaction.changes);
    }
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.startState.field(composing) ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
    ) {
      return blockDecorations(transaction.state);
    }
    return ranges;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const previewTheme = EditorView.baseTheme({
  ".cm-content": { fontFamily: "inherit", lineHeight: "1.65" },
  "[data-preview-heading]": { fontWeight: "650", fontSize: "1.2em" },
  "[data-preview-heading='1']": { fontSize: "1.65em" },
  "[data-preview-heading='2']": { fontSize: "1.35em" },
  "[data-preview-link]": { textDecoration: "underline" },
  "[data-preview-list], [data-preview-task]": { color: "var(--ink)" },
  "[data-preview-quote]": {
    borderInlineStart: "2px solid currentColor",
    paddingInlineStart: "0.6rem",
  },
  "[data-preview-code]": { fontFamily: "monospace", backgroundColor: "var(--inline-code)" },
  ".cm-content code": { backgroundColor: "var(--inline-code)" },
  "[data-preview-block]": { maxWidth: "100%", overflowX: "auto", padding: "0.2rem 0.4rem" },
  "[data-preview-block='table'] table": { borderCollapse: "collapse", cursor: "text" },
  "[data-preview-block='table'] td, [data-preview-block='table'] th": {
    border: "1px solid currentColor",
    padding: "0.2rem 0.5rem",
  },
});

export const livePreview = [previewBlocks, previewInline, previewTheme];
