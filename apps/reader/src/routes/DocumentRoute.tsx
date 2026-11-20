import { getRouteApi } from "@tanstack/react-router";
import { DocumentPage } from "../features/document/DocumentPage";

const route = getRouteApi("/workspaces/$workspaceId/documents/$documentId");

export function DocumentRoute() {
  const { workspaceId, documentId } = route.useParams();
  return <DocumentPage key={documentId} workspace={workspaceId} document={documentId} />;
}
