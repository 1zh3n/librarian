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
    const signature = `${node.type}-${hash(source.slice(from, to))}`;
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    return [{ id: `${documentId}/${signature}-${occurrence}`, kind: node.type, from, to }];
  });
}
