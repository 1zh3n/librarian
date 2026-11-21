import type { ScrollAnchor } from "../../markdown/anchors";

export type AiTranscriptVisit = {
  sourceId: string;
  scrollTop: number;
  draft: string;
};

export type ReadingPosition = {
  anchor: ScrollAnchor | undefined;
  scrollTop: number;
};

export type SourceVisit = {
  documentId: string;
  revision: string;
  transcript: AiTranscriptVisit;
  selection: { from: number; to: number; blockId?: string } | undefined;
  reading: ReadingPosition;
  inline: (ReadingPosition & { passage: string | undefined }) | undefined;
};

type CitedSource = { path: string; revision: string; blockId?: string; from?: number };

export function citationHash(source: CitedSource, sameDocument: boolean) {
  if (source.path.endsWith(".outline.md")) return "reader-outline";
  if (source.from === undefined && !source.blockId) return sameDocument ? "reader-source" : "";
  const params = new URLSearchParams({ revision: source.revision });
  if (source.from !== undefined) params.set("from", String(source.from));
  if (source.blockId) params.set("block", source.blockId);
  return `reader-source?${params}`;
}

export function parseCitationHash(locationHash: string) {
  if (locationHash === "reader-outline") return { outline: true };
  if (locationHash !== "reader-source" && !locationHash.startsWith("reader-source?")) return;
  const params = new URLSearchParams(locationHash.split("?")[1]);
  const offset = params.get("from");
  return {
    outline: false,
    revision: params.get("revision"),
    from:
      offset && /^\d+$/u.test(offset) && Number.isSafeInteger(Number(offset))
        ? Number(offset)
        : undefined,
    block: params.get("block"),
  };
}
