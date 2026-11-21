import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useLocation } from "@tanstack/react-router";
import { workspacesQuery } from "../api/queries";
import { DocumentPage } from "../features/document/DocumentPage";
import { citationVisits } from "./router";

const route = getRouteApi("/workspaces/$workspaceId/documents/$documentId");

export function DocumentRoute() {
  const { workspaceId, documentId } = route.useParams();
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  const visit = citationVisits.returned(entry);
  const workspaces = useQuery(workspacesQuery);
  const writable =
    workspaces.data?.some((item) => item.id === workspaceId && item.canWrite) ?? false;
  return (
    <DocumentPage
      key={documentId}
      workspace={workspaceId}
      document={documentId}
      writable={writable}
      citationDraft={citationVisits.draft(entry)}
      visit={visit?.documentId === documentId ? visit : undefined}
      onSourceVisit={citationVisits.prepare}
    />
  );
}
