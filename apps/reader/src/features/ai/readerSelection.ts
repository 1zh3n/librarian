import type { Element as HastElement, ElementContent } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Position } from "unist";
import type { MarkdownAnalysis } from "../../markdown/analyze";

export type SourceRange = { from: number; to: number };

type TextSpan = { text: string; position: Position | undefined; inlineCode: boolean };

function textSpans(node: ElementContent, parent: HastElement): TextSpan[] {
  if (node.type === "text") {
    const code = parent.tagName === "code";
    return [
      {
        text: node.value,
        position: node.position ?? (code ? parent.position : undefined),
        // Inline code text carries its own position; fenced/indented code only positions the element.
        inlineCode: code && node.position !== undefined,
      },
    ];
  }
  if (node.type === "element") return node.children.flatMap((child) => textSpans(child, node));
  return [];
}

type CodePart = SourceRange & { text: string };
const codeParts = new WeakMap<HastElement, CodePart[]>();

// HAST gives inline code one position for the entire span. Ask the Markdown parser
// for its literal content and line-ending tokens, which exclude padding, delimiters
// and continuation prefixes in quotes and lists. Only parse a selected block once.
function blockCodeParts(source: string, block: HastElement) {
  const cached = codeParts.get(block);
  if (cached) return cached;
  const start = block.position?.start;
  const end = block.position?.end.offset;
  if (start?.offset === undefined || end === undefined) return [];
  const lineStart = start.offset - (start.column - 1);
  const parts: CodePart[] = [];
  const parser = unified().use(remarkParse).use(remarkGfm);
  parser.data("fromMarkdownExtensions", [
    {
      enter: {
        codeTextData(token) {
          const text = this.sliceSerialize(token);
          parts.push({
            from: lineStart + token.start.offset,
            to: lineStart + token.end.offset,
            text,
          });
          this.enter({ type: "text", value: text }, token);
        },
        lineEnding(token) {
          parts.push({
            from: lineStart + token.start.offset,
            to: lineStart + token.end.offset,
            text: " ",
          });
        },
      },
      exit: {
        codeTextData(token) {
          this.exit(token);
        },
      },
    },
  ]);
  parser.parse(source.slice(lineStart, end));
  codeParts.set(block, parts);
  return parts;
}

function spanOffset(
  source: string,
  block: HastElement,
  span: TextSpan,
  offset: number,
  start: boolean,
) {
  const from = span.position?.start.offset;
  const to = span.position?.end.offset;
  if (from === undefined || to === undefined) return;
  const raw = source.slice(from, to);
  if (raw === span.text) return from + offset;
  if (span.inlineCode && /[\r\n]/u.test(raw)) {
    const parts = blockCodeParts(source, block).filter(
      (part) => part.from >= from && part.to <= to,
    );
    if (parts.map((part) => part.text).join("") === span.text) {
      let remaining = offset;
      for (const part of parts) {
        if (remaining < part.text.length) return part.from + remaining;
        if (!start && remaining === part.text.length) return part.to;
        remaining -= part.text.length;
      }
    }
  }
  const visible = span.text.replace(/\n$/u, "");
  const exact = raw.indexOf(visible);
  if (exact !== -1 && exact === raw.lastIndexOf(visible)) {
    return from + exact + Math.min(offset, visible.length);
  }

  const decoded = document.createElement("textarea");
  const tokens = /\\[!-/:-@[-`{-~]|&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);|\r\n?/gu;
  const offsets: number[] = [0];
  let rendered = "";
  let cursor = 0;
  for (const token of raw.matchAll(tokens)) {
    const index = token.index;
    rendered += raw.slice(cursor, index);
    for (let current = cursor; current < index; current++) offsets.push(current + 1);
    if (token[0].startsWith("&")) {
      decoded.innerHTML = token[0];
    }
    const value = token[0].startsWith("&")
      ? decoded.value
      : token[0].startsWith("\\")
        ? token[0].slice(1)
        : "\n";
    cursor = index + token[0].length;
    rendered += value;
    for (let current = 0; current < value.length; current++) {
      offsets.push(current + 1 === value.length || !start ? cursor : index);
    }
  }
  rendered += raw.slice(cursor);
  for (let current = cursor; current < raw.length; current++) offsets.push(current + 1);
  const mapped = offsets[offset];
  if (rendered === span.text && mapped !== undefined) return from + mapped;
  return offset === 0 ? from : offset === span.text.length ? to : undefined;
}

function boundary(
  source: string,
  blocks: ReadonlyMap<string, HastElement>,
  root: HTMLElement,
  container: Node,
  offset: number,
  start: boolean,
) {
  const node = container instanceof Element ? container : container.parentElement;
  const block = node?.closest<HTMLElement>("[data-block-id]");
  if (!block || !root.contains(block)) return;
  const ast = blocks.get(block.dataset.blockId ?? "");
  if (!ast) return;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(container, offset);
  let remaining = before.toString().length;
  const spans = ast.children.flatMap((child) => textSpans(child, ast));
  if (spans.map(({ text }) => text).join("") !== block.textContent) return;
  for (const span of spans) {
    if (remaining < span.text.length || (!start && remaining === span.text.length)) {
      return spanOffset(source, ast, span, remaining, start);
    }
    remaining -= span.text.length;
  }
}

function blockElements(analysis: MarkdownAnalysis) {
  const nodes = new Map<string, HastElement>();
  for (const child of analysis.tree.children) {
    if (child.type === "element" && typeof child.properties.dataBlockId === "string") {
      nodes.set(child.properties.dataBlockId, child);
    }
  }
  return nodes;
}

export function readerCaretOffset(
  root: HTMLElement,
  point: { node: Node; offset: number },
  source: string,
  analysis: MarkdownAnalysis,
) {
  const hasBom = source.startsWith("\uFEFF");
  const raw = hasBom ? source.slice(1) : source;
  // At an inline boundary, the first character belongs to the span that was
  // clicked. Its opening or the preceding span's closing markup is invisible.
  const atStartOfText = point.node.nodeType === Node.TEXT_NODE && point.offset === 0;
  const offset = boundary(
    raw,
    blockElements(analysis),
    root,
    point.node,
    point.offset,
    atStartOfText,
  );
  return offset === undefined ? undefined : offset + Number(hasBom);
}

export function readerSelection(
  root: HTMLElement,
  range: Range,
  source: string,
  analysis: MarkdownAnalysis,
): SourceRange | undefined {
  if (range.collapsed) return;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const nodes = blockElements(analysis);
  const hasBom = source.startsWith("\uFEFF");
  const raw = hasBom ? source.slice(1) : source;
  const from = boundary(raw, nodes, root, range.startContainer, range.startOffset, true);
  const to = boundary(raw, nodes, root, range.endContainer, range.endOffset, false);
  if (from === undefined || to === undefined || from >= to) return;
  const bom = Number(hasBom);
  return { from: from + bom, to: to + bom };
}
