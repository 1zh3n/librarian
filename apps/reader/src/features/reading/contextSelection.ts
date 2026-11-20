import type { SemanticBlock } from "./semanticFocus";

export function contextSelection({
  source,
  documentId,
  explicit,
  selection,
  focused,
}: {
  source: string;
  documentId: string;
  explicit?: readonly string[];
  selection?: { from: number; to: number };
  focused?: SemanticBlock;
}) {
  if (explicit?.length) return { kind: "explicit" as const, documentIds: explicit };
  if (selection && selection.from < selection.to) {
    return {
      kind: "selection" as const,
      documentId,
      range: selection,
      text: source.slice(selection.from, selection.to),
    };
  }
  if (focused) {
    return {
      kind: "block" as const,
      documentId,
      blockId: focused.id,
      text: source.slice(focused.from, focused.to),
    };
  }
  return { kind: "document" as const, documentId, text: source };
}
