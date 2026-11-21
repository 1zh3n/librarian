import { createMemoryHistory } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { trackCitationVisits } from "../src/features/document/citationHistory";
import type { SourceVisit } from "../src/features/document/sourceVisit";

const visit: SourceVisit = {
  documentId: "origin",
  revision: "first",
  reading: { scrollTop: 114, anchor: undefined },
  selection: undefined,
  inline: undefined,
  transcript: { draft: "继续", sourceId: "receipt", scrollTop: 97, questions: new Map() },
};

test("only a committed citation trip restores a visit and ordinary navigation clears it", () => {
  const history = createMemoryHistory({ initialEntries: ["/origin"] });
  const visits = trackCitationVisits(history);
  const origin = history.location.state.__TSR_key;
  visits.prepare("receipt", () => visit);
  history.push("/different");
  history.back();
  expect(visits.returned(origin)).toBeUndefined();

  visits.prepare("receipt", () => visit);
  history.push("/source", { readerCitation: "receipt", readerCitationOrigin: origin });
  const destination = visits.draft(history.location.state.__TSR_key);
  expect(destination?.read()).toBe("");
  destination?.update("another draft");
  history.push("/manage");
  history.back();
  expect(visits.returned(history.location.state.__TSR_key)).toBeUndefined();
  history.back();
  expect(visits.returned(origin)).toBe(visit);
  history.forward();
  expect(visits.draft(history.location.state.__TSR_key)?.read()).toBe("another draft");
  history.back();
  history.push("/different");
  history.back();
  expect(visits.returned(origin)).toBeUndefined();
});
