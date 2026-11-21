import type { MarkdownAnalysis } from "../../markdown/analyze";
import { readerCaretOffset } from "../ai/readerSelection";

// Paragraph margins and the side gutters have no text node of their own. Project
// sideways onto the displayed line, or vertically onto the closest block edge.
export function readingPositionAtClick(
  article: HTMLElement,
  target: Element,
  { clientX: x, clientY: y }: MouseEvent,
  source: string,
  analysis: MarkdownAnalysis,
): number {
  let element = target.closest<HTMLElement>("[data-block-id]");
  if (!element) {
    const blocks = article.querySelectorAll<HTMLElement>("[data-block-id]");
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (blocks[mid]!.getBoundingClientRect().bottom <= y) lo = mid + 1;
      else hi = mid;
    }
    const next = blocks[lo];
    if (!next) return source.length;
    const previous = blocks[lo - 1];
    const above = next.getBoundingClientRect().top - y;
    element = previous && above > y - previous.getBoundingClientRect().bottom ? previous : next;
  }
  const block = analysis.blocks.find(({ id }) => id === element.dataset.blockId);
  if (!block) return source.length;
  const box = element.getBoundingClientRect();
  if (y < box.top) return block.from;
  if (y >= box.bottom) return block.to;
  const projectedX = Math.max(box.left + 1, Math.min(x, box.right - 1));
  const caret = document.caretPositionFromPoint?.(projectedX, y);
  const range = caret ? undefined : document.caretRangeFromPoint?.(projectedX, y);
  const point = caret
    ? { node: caret.offsetNode, offset: caret.offset }
    : range
      ? { node: range.startContainer, offset: range.startOffset }
      : undefined;
  const offset =
    point && element.contains(point.node)
      ? readerCaretOffset(article, point, source, analysis)
      : undefined;
  return offset ?? (x >= box.right ? block.to : block.from);
}
