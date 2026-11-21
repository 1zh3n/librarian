import type { MarkdownAnalysis } from "../../markdown/analyze";
import { readerCaretOffset } from "../ai/readerSelection";

type ReadingGlyph = { screenTop: number; glyphSide: 1 | -1 };
type ReadingHit = { position: number | "blankLine"; glyph?: ReadingGlyph | undefined };

function caretAtPoint(doc: Document, x: number, y: number) {
  const caret = doc.caretPositionFromPoint?.(x, y);
  if (caret) return { node: caret.offsetNode, offset: caret.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
}

// Browsers return the nearest caret even when the pointer lands in a gutter.
// Check the two characters adjoining that caret, including at a soft wrap.
export function textCaretAtClick(root: HTMLElement, { clientX: x, clientY: y }: MouseEvent) {
  const doc = root.ownerDocument;
  const point = caretAtPoint(doc, x, y);
  if (!point) return;
  const { node, offset } = point;
  if (!(node instanceof Text) || !root.contains(node)) return;
  const range = doc.createRange();
  for (const index of [offset - 1, offset]) {
    if (index < 0 || index >= node.length) continue;
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    for (const box of range.getClientRects()) {
      if (box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const glyph: ReadingGlyph = { screenTop: box.top, glyphSide: index === offset ? 1 : -1 };
        return { node, offset, glyph };
      }
    }
  }
}

// Only measure text within the chosen block. Each rect is a visual fragment,
// so a soft-wrapped paragraph or an indented item has its own left/right edge.
function nearestTextPoint(element: HTMLElement, x: number, y: number) {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let best: { node: Text; rect: DOMRect } | undefined;
  let dy = Infinity;
  let dx = Infinity;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const vertical = Math.max(rect.top - y, y - rect.bottom, 0);
      const horizontal = Math.max(rect.left - x, x - rect.right, 0);
      if (vertical < dy || (vertical === dy && horizontal < dx)) {
        best = { node, rect };
        dy = vertical;
        dx = horizontal;
      }
    }
  }
  if (!best) return;
  const { node, rect } = best;
  const inset = Math.min(0.25, rect.width / 2);
  const projectedX = Math.max(rect.left + inset, Math.min(x, rect.right - inset));
  const point = caretAtPoint(doc, projectedX, rect.top + rect.height / 2);
  const offset = point?.node === node ? point.offset : x <= rect.left ? 0 : node.length;
  // Use the measured fragment's side when two visual lines share the same caret.
  const glyph: ReadingGlyph = {
    screenTop: rect.top,
    glyphSide: x >= rect.right || offset === node.length ? -1 : 1,
  };
  return { node, offset, glyph };
}

export function readingPositionAtClick(
  article: HTMLElement,
  { clientX: x, clientY: y }: MouseEvent,
  source: string,
  analysis: MarkdownAnalysis,
  caret: ReturnType<typeof textCaretAtClick>,
): ReadingHit {
  if (caret) {
    const position = readerCaretOffset(article, caret, source, analysis);
    if (position !== undefined) return { position, glyph: caret.glyph };
  }
  const blocks = article.querySelectorAll<HTMLElement>("[data-block-id]");
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid]!.getBoundingClientRect().bottom <= y) lo = mid + 1;
    else hi = mid;
  }
  const next = blocks[lo];
  if (!next) return { position: "blankLine" };
  const top = next.getBoundingClientRect().top;
  const previous = blocks[lo - 1];
  if (previous && y < top && y - previous.getBoundingClientRect().bottom <= top - y) {
    const block = analysis.blocks.find(({ id }) => id === previous.dataset.blockId);
    if (block) {
      const end = nearestTextPoint(previous, previous.getBoundingClientRect().right, y);
      return { position: block.to, glyph: end?.glyph };
    }
  }
  // A click in the upper margin starts the next paragraph at its first text.
  const point = nearestTextPoint(next, y < top ? next.getBoundingClientRect().left : x, y);
  const offset = point && readerCaretOffset(article, point, source, analysis);
  return {
    position: offset ?? analysis.blocks.find(({ id }) => id === next.dataset.blockId)?.from ?? 0,
    glyph: point?.glyph,
  };
}
