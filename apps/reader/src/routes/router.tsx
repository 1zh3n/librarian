import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";
import { WorkspaceShell } from "./WorkspaceShell";

const root = createRootRoute({ component: WorkspaceShell });
const home = createRoute({ getParentRoute: () => root, path: "/" });
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

export const router = createRouter({
  routeTree: root.addChildren([home, workspace, document, workspaceAi]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
