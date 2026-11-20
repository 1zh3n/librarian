import type { Block } from "../../markdown/blocks";

export type SemanticBlock = {
  readonly id: string;
  readonly ids: readonly string[];
  readonly from: number;
  readonly to: number;
};

export function semanticBlocks(blocks: readonly Block[]): SemanticBlock[] {
  const result: SemanticBlock[] = [];
  let headings: Block[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      headings.push(block);
      continue;
    }
    const first = headings[0] ?? block;
    result.push({
      id: first.id,
      ids: [...headings.map(({ id }) => id), block.id],
      from: first.from,
      to: block.to,
    });
    headings = [];
  }
  return result;
}

export function isRepeatedSemanticBlock(block: string, units: readonly SemanticBlock[]) {
  const signature = block.slice(0, block.lastIndexOf("-"));
  let occurrences = 0;
  for (const { id } of units) {
    if (id.slice(0, id.lastIndexOf("-")) === signature) occurrences += 1;
    if (occurrences > 1) return true;
  }
  return false;
}

export function renderedBlock(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
}

export function showSemanticBlock(root: HTMLElement, block: SemanticBlock) {
  const first = renderedBlock(root, block.id);
  const lastId = block.ids.at(-1);
  const last = lastId ? renderedBlock(root, lastId) : null;
  const viewport = root.closest("main");
  if (!first || !last || !viewport) return;
  const bounds = viewport.getBoundingClientRect();
  const top = first.getBoundingClientRect().top;
  const height = last.getBoundingClientRect().bottom - top;
  const target = height >= bounds.height ? bounds.top : bounds.top + (bounds.height - height) / 2;
  window.getSelection()?.removeAllRanges();
  viewport.scrollTop += top - target;
}

export function visibleSemanticBlock(root: HTMLElement, blocks: readonly SemanticBlock[]) {
  const top = root.closest("main")?.getBoundingClientRect().top ?? 0;
  return blocks.find((block) => {
    const last = block.ids.at(-1);
    return last && (renderedBlock(root, last)?.getBoundingClientRect().bottom ?? -1) > top;
  });
}
