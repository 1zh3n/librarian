import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Workspace } from "../src/api/client";
import { FileActionDialog } from "../src/features/navigation/FileActionDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const workspace: Workspace = {
  id: "personal",
  name: "个人笔记",
  spaceId: "personal",
  origin: "native",
  retention: "persistent",
  revisionMode: "managed",
  defaults: { outlineEnabled: false },
  canWrite: true,
  canManage: true,
  expiresAt: null,
};
const counts = { gainedRead: 0, gainedWrite: 0, lost: 0, upgraded: 0, downgraded: 0 };

test("delete confirms affected files and retries a lost response with its original token and operation ID", async () => {
  const calls: { operationId: string; token: string }[] = [];
  vi.stubGlobal("fetch", (url: string, opts: RequestInit) => {
    if (url.endsWith("/preview"))
      return Promise.resolve(Response.json({ token: "original", fileCount: 4, access: counts }));
    if (url.endsWith("/apply")) {
      if (typeof opts.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(opts.body) as { operationId: string; token: string };
      calls.push(body);
      if (calls.length === 1) return Promise.reject(new TypeError("connection reset"));
      return Promise.resolve(
        Response.json({
          operationId: body.operationId,
          workspaceId: "personal",
          path: "草稿",
          undoable: true,
        }),
      );
    }
    throw Error(url);
  });
  let deleted = false;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileActionDialog
        source={{ workspace, kind: "folder", folderId: "original-folder", path: "草稿" }}
        action="delete"
        workspaces={[workspace]}
        prepareSource={async () => {}}
        done={() => {
          deleted = true;
        }}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/4 个文件/u)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(deleted).toBe(true), { timeout: 4000 });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.operationId).toBeTruthy();
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject({
    token: "original",
    sourceKind: "folder",
    expectedFolderId: "original-folder",
    sourcePath: "草稿",
    action: "delete",
  });
});

test("a stale access preview keeps the destination and waits for confirmation of its new permissions", async () => {
  const readOnly = { ...workspace, canWrite: false, canManage: false };
  const target = { ...workspace, id: "target", name: "船队档案" };
  let changed = false;
  const applied: string[] = [];
  vi.stubGlobal("fetch", (url: string, opts: RequestInit) => {
    if (url.endsWith("/folders")) return Promise.resolve(Response.json({ folders: [] }));
    if (url.endsWith("/preview"))
      return Promise.resolve(
        Response.json({
          token: changed ? "v2" : "v1",
          fileCount: 1,
          access: { ...counts, gainedRead: changed ? 3 : 0 },
        }),
      );
    if (url.endsWith("/apply") && typeof opts.body === "string") {
      const body = JSON.parse(opts.body) as { token: string; operationId: string };
      applied.push(body.token);
      if (!changed) {
        changed = true;
        return Promise.resolve(
          Response.json({ code: "file_action_changed", message: "verify again" }, { status: 409 }),
        );
      }
      return Promise.resolve(
        Response.json({
          operationId: body.operationId,
          workspaceId: "target",
          path: "周报.md",
          documentId: "new-doc",
          undoable: false,
        }),
      );
    }
    throw new Error(url);
  });
  let done = false;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileActionDialog
        action="copy"
        source={{
          workspace: readOnly,
          kind: "document",
          path: "草稿/周报.md",
          documentId: "old-doc",
        }}
        workspaces={[readOnly, target]}
        prepareSource={async () => {}}
        done={() => {
          done = true;
        }}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  const submit = screen.getByRole("button", { name: "复制到此处" });
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  expect(screen.queryByText(/原件权限/u)).toBeNull();
  fireEvent.click(submit);
  expect(await screen.findByText(/3 位成员将获得阅读权限/u)).toBeDefined();
  expect(screen.getByRole("button", { name: /目标空间/u }).textContent).toContain("船队档案");
  expect(applied).toEqual(["v1"]);
  expect(done).toBe(false);
  await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  fireEvent.click(submit);
  await waitFor(() => expect(done).toBe(true));
  expect(applied).toEqual(["v1", "v2"]);
});

test.each([
  [422, /名称或位置/u],
  [413, /文件.*过多|体积/u],
] as const)("a %i rejection explains how to change the selection", async (status, message) => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      Response.json(
        {
          code: status === 422 ? "invalid_request" : "payload_too_large",
          message: "invalid selection",
        },
        { status },
      ),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileActionDialog
        action="delete"
        source={{ workspace, kind: "folder", folderId: "original-folder", path: "资料" }}
        workspaces={[workspace]}
        prepareSource={async () => {}}
        done={() => {}}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole("alert")).textContent).toMatch(message);
});

test("manual retry recovers an undoable deletion committed before a gateway 502", async () => {
  const bodies: string[] = [];
  let restoredReceipt: string | undefined;
  vi.stubGlobal("fetch", (url: string, opts: RequestInit) => {
    if (url.endsWith("/preview"))
      return Promise.resolve(Response.json({ token: "seen", fileCount: 2, access: counts }));
    if (!url.endsWith("/apply") || typeof opts.body !== "string") throw new Error(url);
    const body = opts.body;
    bodies.push(body);
    if (bodies.length === 1) return Promise.resolve(new Response(null, { status: 502 }));
    if (body !== bodies[0])
      return Promise.resolve(
        Response.json({ code: "not_found", message: "already deleted" }, { status: 404 }),
      );
    const { operationId } = JSON.parse(body) as { operationId: string };
    return Promise.resolve(
      Response.json({ operationId, workspaceId: "personal", path: "草稿", undoable: true }),
    );
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileActionDialog
        action="delete"
        source={{ workspace, kind: "folder", folderId: "original-folder", path: "草稿" }}
        workspaces={[workspace]}
        prepareSource={async () => {}}
        close={() => {}}
        done={(result) => {
          if (result.undoable) restoredReceipt = result.operationId;
        }}
      />
    </QueryClientProvider>,
  );
  await screen.findByText(/2 个文件/u);
  const submit = screen.getByRole("button", { name: "删除" });
  fireEvent.click(submit);
  await screen.findByRole("alert");
  fireEvent.click(submit);
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0]!) as unknown).toMatchObject({
    token: "seen",
    operationId: restoredReceipt,
  });
});

test("the first preview includes the flushed content of the affected source", async () => {
  let saved = false;
  const tokens: string[] = [];
  vi.stubGlobal("fetch", (url: string, opts: RequestInit) => {
    if (url.endsWith("/preview"))
      return Promise.resolve(
        Response.json({ token: saved ? "saved" : "old", fileCount: 1, access: counts }),
      );
    if (!url.endsWith("/apply") || typeof opts.body !== "string") throw new Error(url);
    const body = JSON.parse(opts.body) as { token: string; operationId: string };
    tokens.push(body.token);
    if (body.token !== "saved")
      return Promise.resolve(
        Response.json({ code: "file_action_changed", message: "content changed" }, { status: 409 }),
      );
    return Promise.resolve(
      Response.json({
        operationId: body.operationId,
        workspaceId: "personal",
        path: "草稿",
        undoable: true,
      }),
    );
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileActionDialog
        action="delete"
        source={{ workspace, kind: "folder", folderId: "original-folder", path: "草稿" }}
        workspaces={[workspace]}
        prepareSource={async () => {
          saved = true;
        }}
        close={() => {}}
        done={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByText(/1 个文件/u);
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(tokens).toHaveLength(1));
  expect(tokens).toEqual(["saved"]);
});
