import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Workspace } from "../src/api/client";
import { fileActionName } from "../src/features/navigation/fileActions";
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
  securityLevel: "internal",
  capabilities: {
    externalAi: true,
    externalMcp: true,
    anonymousShare: true,
    publication: false,
    offline: true,
    remoteBackup: true,
  },
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

test("same-folder copy skips a server-side collision but leaves a user's conflicting name editable", async () => {
  const paths: string[] = [];
  const applied: string[] = [];
  vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
    if (url.endsWith("/folders"))
      return Promise.resolve(Response.json({ folders: ["采编"], identities: {} }));
    if (typeof options.body !== "string") throw new Error("Expected a file action body");
    const { targetPath } = JSON.parse(options.body) as { targetPath: string };
    if (url.endsWith("/preview")) {
      paths.push(targetPath);
      if (targetPath === "采编/周报（副本）.md" || targetPath === "采编/占用.md")
        return Promise.resolve(
          Response.json({ code: "path_exists", message: "path occupied" }, { status: 409 }),
        );
      return Promise.resolve(Response.json({ token: targetPath, access: counts, fileCount: 1 }));
    }
    if (url.endsWith("/apply")) {
      applied.push(targetPath);
      return Promise.resolve(
        Response.json({
          workspaceId: "personal",
          path: targetPath,
          undoable: false,
          operationId: "copy",
        }),
      );
    }
    throw new Error(url);
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileActionDialog
        action="copy"
        source={{ workspace, kind: "document", path: "采编/周报.md", documentId: "doc" }}
        workspaces={[workspace]}
        prepareSource={async () => {}}
        done={() => {}}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  const name = screen.getByRole<HTMLInputElement>("textbox", { name: "副本名称" });
  await waitFor(() => expect(name.value).toBe("周报（副本 2）.md"));
  expect(paths).toContain("采编/周报（副本）.md");
  fireEvent.change(name, { target: { value: "占用.md" } });
  expect((await screen.findByRole("alert")).textContent).toMatch(/同名/u);
  const submit = screen.getByRole<HTMLButtonElement>("button", { name: "复制到此处" });
  expect(submit.disabled || submit.getAttribute("aria-disabled") === "true").toBe(true);
  fireEvent.change(name, { target: { value: "新标题.md" } });
  await waitFor(() =>
    expect(submit.disabled || submit.getAttribute("aria-disabled") === "true").toBe(false),
  );
  fireEvent.click(submit);
  await waitFor(() => expect(applied).toEqual(["采编/新标题.md"]));
});

test("shows the first locally free sibling name while its server preview is pending", () => {
  const client = new QueryClient();
  client.setQueryData(
    ["workspaces", "personal", "documents"],
    [{ path: "采编/周报（副本）.md" }, { path: "外地/周报（副本 2）.md" }],
  );
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
  render(
    <QueryClientProvider client={client}>
      <FileActionDialog
        action="copy"
        source={{ workspace, kind: "document", path: "采编/周报.md", documentId: "doc" }}
        workspaces={[workspace]}
        prepareSource={async () => {}}
        done={() => {}}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "副本名称" }).value).toBe(
    "周报（副本 2）.md",
  );
});

test("destination names keep folder suffixes and protect Markdown outline paths", () => {
  expect(fileActionName(" 纪要 ", "document")).toBe("纪要.md");
  expect(fileActionName(" 纪要.MD ", "document")).toBe("纪要.md");
  expect(fileActionName("纪要.outline.md", "document")).toBeUndefined();
  expect(fileActionName("../其他", "folder")).toBeUndefined();
  expect(fileActionName("归档.md", "folder")).toBe("归档.md");
});
