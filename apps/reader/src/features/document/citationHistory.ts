import type { RouterHistory } from "@tanstack/react-router";
import type { SourceVisit } from "./sourceVisit";

declare module "@tanstack/history" {
  interface HistoryState {
    readerCitation?: string;
    readerCitationOrigin?: string | undefined;
  }
}

export type CitationDraft = {
  read: () => string;
  update: (value: string) => void;
};

function createDraft(initial: string): CitationDraft {
  let text = initial;
  return {
    read: () => text,
    update: (value) => {
      text = value;
    },
  };
}

export function trackCitationVisits(history: RouterHistory) {
  const entries = new Map<string, { draft: CitationDraft; visit?: SourceVisit }>();
  function remember(key: string, text: string, visit?: SourceVisit) {
    entries.delete(key);
    entries.set(key, { draft: createDraft(text), ...(visit && { visit }) });
    const oldest = entries.keys().next();
    if (entries.size > 100 && !oldest.done) entries.delete(oldest.value);
  }
  let previous = history.location.state;
  let pending: { sourceId: string; capture: () => SourceVisit } | undefined;
  let returned: SourceVisit | undefined;

  // History publishes a push only after the editor's navigation blocker has finished saving.
  history.subscribe(({ location, action }) => {
    const next = location.state;
    if (next.__TSR_key === previous.__TSR_key) return;
    const origin = previous.__TSR_key;
    returned = undefined;
    if (origin && (action.type === "PUSH" || action.type === "REPLACE")) {
      const abandoned = entries.get(origin);
      if (abandoned) delete abandoned.visit;
      if (
        action.type === "PUSH" &&
        next.__TSR_key &&
        pending &&
        next.readerCitationOrigin === origin &&
        next.readerCitation === pending.sourceId
      ) {
        const visit = pending.capture();
        remember(origin, visit.transcript.draft, visit);
        remember(next.__TSR_key, "");
      }
    } else if (next.__TSR_key && next.__TSR_index < previous.__TSR_index) {
      returned = entries.get(next.__TSR_key)?.visit;
    }
    previous = next;
    pending = undefined;
  });

  return {
    prepare: (sourceId: string, capture: () => SourceVisit) => {
      pending = { sourceId, capture };
    },
    draft(entry: string | undefined) {
      return entry ? entries.get(entry)?.draft : undefined;
    },
    returned(entry: string | undefined) {
      return entry === previous.__TSR_key ? returned : undefined;
    },
  };
}
