import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { SourceVisit } from "../features/document/sourceVisit";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { workspacesQuery } from "../api/queries";
import { DocumentPage } from "../features/document/DocumentPage";

const route = getRouteApi("/workspaces/$workspaceId/documents/$documentId");

export function DocumentRoute() {
  const { workspaceId, documentId } = route.useParams();
  const [visits] = useState(() => new Map<string, SourceVisit>());
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  // A new visit to the same URL has its own entry and its own reading position.
  const visit = useMemo(() => (entry ? visits.get(entry) : undefined), [entry, visits]);
  const workspaces = useQuery(workspacesQuery);
  const writable =
    workspaces.data?.some((item) => item.id === workspaceId && item.canWrite) ?? false;
  return (
    <DocumentPage
      key={documentId}
      workspace={workspaceId}
      document={documentId}
      writable={writable}
      visit={visit?.documentId === documentId ? visit : undefined}
      onSourceVisit={(next) => {
        if (!entry) return;
        visits.set(entry, next);
        const oldest = visits.keys().next();
        if (visits.size > 50 && !oldest.done) visits.delete(oldest.value);
      }}
    />
  );
}
