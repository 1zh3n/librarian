import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { workspacesQuery } from "../api/queries";
import { DocumentPage } from "../features/document/DocumentPage";

const route = getRouteApi("/workspaces/$workspaceId/documents/$documentId");

export function DocumentRoute() {
  const { workspaceId, documentId } = route.useParams();
  const workspaces = useQuery(workspacesQuery);
  const writable =
    workspaces.data?.some((item) => item.id === workspaceId && item.canWrite) ?? false;
  return (
    <DocumentPage
      key={documentId}
      workspace={workspaceId}
      document={documentId}
      writable={writable}
    />
  );
}
