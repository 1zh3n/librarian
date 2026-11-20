import type { AiContext, DocumentSummary } from "../../api/client";

export class ContextUnavailable extends Error {}

const reference = /(?:^|\s)@(?:"([^"]+)"|([^\s，。；！？,;!?]+))/gu;

export function explicitReferences(prompt: string, documents: readonly DocumentSummary[]) {
  const matched = new Map<string, DocumentSummary>();
  const missing: string[] = [];
  for (const token of prompt.matchAll(reference)) {
    const path = token[1] ?? token[2] ?? "";
    const clean = path.replace(/^\.\//u, "").replace(/^\//u, "");
    const exact = documents.find((document) => document.path === clean);
    const directory = clean.endsWith("/") ? clean : `${clean}/`;
    const matches = exact
      ? [exact]
      : documents.filter((document) => document.path.startsWith(directory));
    if (matches.length === 0) missing.push(path);
    for (const document of matches) matched.set(document.id, document);
  }
  return { documents: Array.from(matched.values()), missing };
}

export function referenceContext(documents: readonly DocumentSummary[]): AiContext[] {
  return documents.map(({ id }) => ({ documentId: id }));
}
