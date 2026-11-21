import type { ScrollAnchor } from "../../markdown/anchors";

export type AiTranscriptVisit = {
  sourceId: string;
  scrollTop: number;
  draft: string;
  conversation?: { username: string; id: string; materialIds?: readonly string[] };
  questions: ReadonlyMap<string, string>;
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

export function citationHash(source: CitedSource) {
  const params = new URLSearchParams({ revision: source.revision });
  if (source.path.endsWith(".outline.md")) return `reader-outline?${params}`;
  if (source.from !== undefined) params.set("from", String(source.from));
  if (source.blockId) params.set("block", source.blockId);
  return `reader-source?${params}`;
}

export function parseCitationHash(locationHash: string) {
  const [kind, query] = locationHash.split("?", 2);
  if (kind !== "reader-source" && kind !== "reader-outline") return;
  const params = new URLSearchParams(query);
  if (kind === "reader-outline") return { outline: true, revision: params.get("revision") };
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
