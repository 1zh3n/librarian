import type { Block } from "./blocks";

export interface ScrollAnchor {
  readonly blockId: string;
  readonly sourceOffset: number;
  readonly insetPx: number;
}

export type AnchorPlacement = { readonly anchor: ScrollAnchor; readonly sameRevision: boolean };

// Sample below the viewport edge so a sliver of the previous block does not
// become the anchor when the next block is already being read.
export const anchorSampleInset = 36;

export function resolveAnchor(
  blocks: readonly Block[],
  anchor: ScrollAnchor,
  sameRevision: boolean,
): Block | undefined {
  if (sameRevision) {
    const exact = blocks.find(({ id }) => id === anchor.blockId);
    if (exact) return exact;
  }
  return blockAtOffset(blocks, anchor.sourceOffset);
}

export function blockAtOffset(blocks: readonly Block[], offset: number): Block | undefined {
  return blocks.find(({ to }) => to > offset) ?? blocks.at(-1);
}

export function captureReaderAnchor(
  viewport: HTMLElement,
  blocks: readonly Block[],
): ScrollAnchor | undefined {
  if (viewport.scrollTop === 0) return;
  const top = viewport.getBoundingClientRect().top;
  for (const element of viewport.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= top + anchorSampleInset) continue;
    const block = blocks.find(({ id }) => id === element.dataset.blockId);
    if (block) {
      return { blockId: block.id, sourceOffset: block.from, insetPx: rect.top - top };
    }
  }
}

export function restoreReaderAnchor(
  viewport: HTMLElement,
  blocks: readonly Block[],
  anchor: ScrollAnchor,
  sameRevision: boolean,
): () => void {
  const block = resolveAnchor(blocks, anchor, sameRevision);
  const target = block && viewport.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
  const article = viewport.querySelector("article");
  if (!target || !article) return () => {};

  const restore = () => {
    const inset = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    if (Math.abs(inset - anchor.insetPx) > 1) {
      viewport.scrollTop += inset - anchor.insetPx;
    }
  };
  restore();
  const observer = new ResizeObserver(restore);
  observer.observe(article);
  const stop = () => observer.disconnect();
  const input = new AbortController();
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    viewport.addEventListener(event, stop, { once: true, signal: input.signal });
  }
  return () => {
    stop();
    input.abort();
  };
}
