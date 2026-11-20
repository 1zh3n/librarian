import type { Root } from "mdast";

export type Block = {
  readonly id: string;
  readonly kind: Root["children"][number]["type"];
  readonly from: number;
  readonly to: number;
};

function hash(text: string): string {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  }
  return (value >>> 0).toString(36);
}

export function blockSignature(id: string): string {
  return id.slice(0, id.lastIndexOf("-"));
}

export function nextBlockId(signature: string, occurrences: Map<string, number>): string {
  const occurrence = (occurrences.get(signature) ?? 0) + 1;
  occurrences.set(signature, occurrence);
  return `${signature}-${occurrence}`;
}

export function collectBlocks(
  tree: Root,
  source: string,
  documentId: string,
  offset: number,
): Block[] {
  const occurrences = new Map<string, number>();
  return tree.children.flatMap((node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      return [];
    }
    if (
      node.type === "yaml" ||
      node.type === "html" ||
      node.type === "definition" ||
      node.type === "footnoteDefinition"
    ) {
      return [];
    }
    const from = start + offset;
    const to = end + offset;
    const signature = `${documentId}/${node.type}-${hash(source.slice(from, to))}`;
    return [{ id: nextBlockId(signature, occurrences), kind: node.type, from, to }];
  });
}
