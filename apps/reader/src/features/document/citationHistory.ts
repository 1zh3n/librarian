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

function createDraft(): CitationDraft {
  let text = "";
  return {
    read: () => text,
    update: (value) => {
      text = value;
    },
  };
}

export function trackCitationVisits(history: RouterHistory) {
  const visits = new Map<
    string,
    {
      source: SourceVisit;
      destination: string;
      draft: CitationDraft;
    }
  >();
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
      visits.delete(origin);
      if (
        action.type === "PUSH" &&
        next.__TSR_key &&
        pending &&
        next.readerCitationOrigin === origin &&
        next.readerCitation === pending.sourceId
      ) {
        visits.set(origin, {
          source: pending.capture(),
          destination: next.__TSR_key,
          draft: createDraft(),
        });
        const oldest = visits.keys().next();
        if (visits.size > 50 && !oldest.done) visits.delete(oldest.value);
      }
    } else if (next.__TSR_key && next.__TSR_index < previous.__TSR_index) {
      returned = visits.get(next.__TSR_key)?.source;
    }
    previous = next;
    pending = undefined;
  });

  return {
    prepare: (sourceId: string, capture: () => SourceVisit) => {
      pending = { sourceId, capture };
    },
    draft(entry: string | undefined) {
      for (const trip of visits.values()) {
        if (trip.destination === entry) return trip.draft;
      }
    },
    returned(entry: string | undefined) {
      return entry === previous.__TSR_key ? returned : undefined;
    },
  };
}
