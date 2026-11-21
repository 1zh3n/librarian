import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { trackCitationVisits } from "../features/document/citationHistory";
import { WorkspaceShell } from "./WorkspaceShell";

function RootRoute() {
  const snapshot = useRouterState({
    select: ({ matches }) => matches.some(({ routeId }) => routeId === "/r/$snapshotId"),
  });
  return snapshot ? <Outlet /> : <WorkspaceShell />;
}

const root = createRootRoute({ component: RootRoute });
const home = createRoute({ getParentRoute: () => root, path: "/" });
const accounts = createRoute({
  getParentRoute: () => root,
  path: "/accounts",
  component: lazyRouteComponent(() => import("./AccountsRoute"), "AccountsRoute"),
});
const workspace = createRoute({ getParentRoute: () => root, path: "/workspaces/$workspaceId" });
const document = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/documents/$documentId",
  component: lazyRouteComponent(() => import("./DocumentRoute"), "DocumentRoute"),
});

const workspaceAi = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/ai",
  component: lazyRouteComponent(() => import("./WorkspaceAiRoute"), "WorkspaceAiRoute"),
});

const workspaceCreate = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/new",
  component: lazyRouteComponent(() => import("./WorkspaceManagementRoute"), "CreateWorkspaceRoute"),
});

const workspaceManagement = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/manage",
  component: lazyRouteComponent(
    () => import("./WorkspaceManagementRoute"),
    "WorkspaceManagementRoute",
  ),
});

const snapshot = createRoute({
  getParentRoute: () => root,
  path: "/r/$snapshotId",
  validateSearch: (value: Record<string, unknown>) =>
    typeof value.documentId === "string" && value.documentId
      ? { documentId: value.documentId }
      : {},
  component: lazyRouteComponent(() => import("./SnapshotRoute"), "SnapshotRoute"),
});

export const router = createRouter({
  routeTree: root.addChildren([
    home,
    accounts,
    workspace,
    document,
    workspaceAi,
    workspaceCreate,
    workspaceManagement,
    snapshot,
  ]),
});

export const citationVisits = trackCitationVisits(router.history);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
