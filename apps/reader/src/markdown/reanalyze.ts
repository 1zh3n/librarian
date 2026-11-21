import type { RootContent } from "hast";
import type { Point, Position } from "unist";
import { analyzeMarkdown } from "./analyze";
import type { DocumentHeading, MarkdownAnalysis } from "./analyze";
import { blockSignature, nextBlockId } from "./blocks";
import type { Block } from "./blocks";

type ReadingSnapshot = { readonly source: string; readonly analysis: MarkdownAnalysis };

const complexLine = /^[ *]| $|[^#* \p{L}\p{N}\p{M}、。！？]/u;

function relocate<T extends RootContent>(node: T, mapPoint: (point: Point) => Point): T {
  const position = node.position;
  const children =
    node.type === "element" ? node.children.map((child) => relocate(child, mapPoint)) : undefined;
  return {
    ...node,
    ...(position && { position: { start: mapPoint(position.start), end: mapPoint(position.end) } }),
    ...(children && { children }),
  };
}

function commonPrefix(before: string, after: string): number {
  let index = 0;
  while (index < before.length && before.charCodeAt(index) === after.charCodeAt(index)) index++;
  return index;
}

// Blank lines isolate a top-level paragraph or ATX heading. Asterisks can
// add inline emphasis, but a leading asterisk can start a list or a thematic
// break. The allowed characters also rule out definitions and references.
function reparseLine(
  source: string,
  documentId: string,
  previous: ReadingSnapshot,
): MarkdownAnalysis | undefined {
  const before = previous.source;
  const firstChange = commonPrefix(before, source);
  const changed = previous.analysis.blocks.find(
    (block) => block.from <= firstChange && firstChange <= block.to,
  );
  if (!changed || (changed.kind !== "heading" && changed.kind !== "paragraph")) return;

  const delta = source.length - before.length;
  const endOfNewLine = changed.to + delta;
  const line = source.slice(changed.from, endOfNewLine);
  if (
    (changed.from > 0 && before.slice(changed.from - 2, changed.from) !== "\n\n") ||
    (changed.to < before.length && before.slice(changed.to, changed.to + 2) !== "\n\n") ||
    complexLine.test(before.slice(changed.from, changed.to)) ||
    endOfNewLine <= changed.from ||
    before.slice(changed.to) !== source.slice(endOfNewLine) ||
    complexLine.test(line)
  )
    return;

  const oldElement = previous.analysis.tree.children.find(
    (child) => child.type === "element" && child.properties.dataBlockId === changed.id,
  );
  if (oldElement?.type !== "element" || !oldElement.position) return;

  const local = analyzeMarkdown(line, documentId);
  const localBlock = local.blocks[0];
  const localElement = local.tree.children[0];
  if (
    !localBlock ||
    localElement?.type !== "element" ||
    (localBlock.kind !== "heading" && localBlock.kind !== "paragraph")
  )
    return;

  const lineStart = oldElement.position.start;
  const lineOffset = lineStart.offset ?? changed.from;
  const mapNewLinePoint = (point: Point): Point => ({
    ...point,
    line: lineStart.line + point.line - 1,
    ...(point.offset !== undefined && { offset: point.offset + lineOffset }),
  });
  const mapOldPoint = (point: Point): Point =>
    point.offset !== undefined && point.offset >= lineOffset
      ? {
          ...point,
          offset: point.offset + delta,
          column: point.line === lineStart.line ? point.column + delta : point.column,
        }
      : point;

  const oldHeadings = new Map(previous.analysis.headings.map((heading) => [heading.id, heading]));
  const headings: DocumentHeading[] = [];
  const blocksByOldId = new Map<string, Block>();
  const occurrences = new Map<string, number>();
  const blocks = previous.analysis.blocks.map((oldBlock) => {
    const edited = oldBlock === changed;
    const block = edited
      ? { ...localBlock, from: changed.from, to: changed.to + delta }
      : oldBlock.from > changed.to
        ? { ...oldBlock, from: oldBlock.from + delta, to: oldBlock.to + delta }
        : oldBlock;
    const id = nextBlockId(blockSignature(block.id), occurrences);
    const next = id === block.id ? block : { ...block, id };
    const heading = edited ? local.headings[0] : oldHeadings.get(oldBlock.id);
    if (heading) headings.push({ ...heading, id });
    blocksByOldId.set(oldBlock.id, next);
    return next;
  });

  const children = previous.analysis.tree.children.map((child) => {
    const blockId = child.type === "element" ? child.properties.dataBlockId : undefined;
    const block = typeof blockId === "string" ? blocksByOldId.get(blockId) : undefined;
    const edited = child === oldElement;
    const node = edited ? relocate(localElement, mapNewLinePoint) : relocate(child, mapOldPoint);
    if (node.type === "element" && block && block.id !== node.properties.dataBlockId) {
      const properties = { ...node.properties, dataBlockId: block.id };
      if (block.kind === "heading" && node.properties.id === node.properties.dataBlockId) {
        properties.id = block.id;
      }
      return { ...node, properties };
    }
    return node;
  });
  const root = previous.analysis.tree;
  const position: Position | undefined = root.position
    ? { start: root.position.start, end: mapOldPoint(root.position.end) }
    : undefined;
  return {
    blankLines: previous.analysis.blankLines,
    blocks,
    headings,
    tree: { ...root, children, ...(position && { position }) },
  };
}

export function reanalyzeMarkdown(
  source: string,
  documentId: string,
  previous: ReadingSnapshot,
): MarkdownAnalysis {
  const priorId = previous.analysis.blocks[0]?.id;
  if (priorId && priorId.slice(0, priorId.lastIndexOf("/")) !== documentId) {
    return analyzeMarkdown(source, documentId);
  }
  if (source === previous.source) return previous.analysis;
  return reparseLine(source, documentId, previous) ?? analyzeMarkdown(source, documentId);
}
