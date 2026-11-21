import { queryOptions } from "@tanstack/react-query";
import { api } from "../../api/client";
import { workspaceKeys } from "../../api/queries";

export function deliveryHistory(workspace: string) {
  return queryOptions({
    queryKey: [...workspaceKeys.workspace(workspace), "deliveries"],
    queryFn: ({ signal }) => api.listDeliveries(workspace, signal),
  });
}
