import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useAiConversation } from "../src/features/ai/useAiConversation";
import { sessionQuery } from "../src/api/queries";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const session = { username: "reader", cacheId: "a".repeat(64), isAdmin: false };
const conversation = { id: "thread", workspaceId: "w", documentId: "doc", title: "第一问" };

function mount(
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  initialProps = { workspace: "w", doc: "doc" as string | undefined, global: false },
  returned?: string,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  const fetch = vi.fn((path: string, init?: RequestInit) => {
    const url = new URL(path, "http://reader.test");
    return url.pathname === "/api/v1/session" ? Response.json(session) : respond(url, init);
  });
  vi.stubGlobal("fetch", fetch);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(
      ({ workspace, doc, global }) =>
        useAiConversation(
          workspace,
          doc,
          true,
          returned ? { username: "reader", id: returned } : undefined,
          global,
        ),
      { wrapper, initialProps },
    ),
    fetch,
  };
}

test("a document keeps its scoped listing and remembered selection after upgrading", async () => {
  sessionStorage.setItem(
    JSON.stringify(["workspaces", "w", "ai", "conversations", "reader", "doc"]),
    conversation.id,
  );
  const { result, fetch } = mount((url) => {
    if (url.pathname.endsWith("/turns")) return Response.json({ items: [] });
    if (url.pathname.endsWith("/thread")) return Response.json(conversation);
    return Response.json({ items: [conversation] });
  });
  await waitFor(() => expect(result.current.turnsQuery.isSuccess).toBe(true));
  expect(result.current.conversations[0]?.title).toBe("第一问");
  expect(fetch.mock.calls.map(([url]) => url)).toContain(
    "/api/v1/ai/conversations?workspaceId=w&documentId=doc",
  );
  expect(result.current.id).toBe("thread");
});

test("a remembered conversation in a different scope is never read or posted to", async () => {
  const { result, fetch } = mount(
    (url) => {
      if (url.pathname.endsWith("/other"))
        return Response.json({ ...conversation, id: "other", workspaceId: "elsewhere" });
      return Response.json({ items: [] });
    },
    undefined,
    "other",
  );
  await waitFor(() =>
    expect(fetch.mock.calls.some(([path]) => path.endsWith("/other"))).toBe(true),
  );
  await act(async () => {});
  expect(result.current.id).toBeUndefined();
  expect(fetch.mock.calls.filter(([path]) => path.endsWith("/other/turns"))).toEqual([]);
});

test("global history and new conversations use explicit global scope on the wire", async () => {
  const global = { id: "global-thread", scope: "global", documentId: null, title: null };
  const { result, fetch } = mount(
    (url, init) => {
      if (init?.method === "POST") return Response.json(global);
      if (url.pathname.endsWith("/global-thread")) return Response.json(global);
      return Response.json({ items: [] });
    },
    { workspace: "", doc: undefined, global: true },
  );
  await waitFor(() => expect(result.current.listing.isSuccess).toBe(true));
  expect(fetch.mock.calls.map(([path]) => path)).toContain("/api/v1/ai/conversations?scope=global");
  await act(async () => {
    expect(await result.current.ensureConversation()).toBe(global.id);
  });
  expect(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body).toBe(
    JSON.stringify({ scope: "global" }),
  );
});

test.each([401, 403, 404])(
  "history hides cached private data after HTTP %d on refetch",
  async (status) => {
    let revoked = false;
    const { result } = mount((url) => {
      if (url.pathname.endsWith("/turns"))
        return revoked
          ? Response.json({ code: "not_found", message: "unavailable" }, { status })
          : Response.json({ items: [{ prompt: "private" }] });
      return Response.json({ items: [conversation] });
    });
    await waitFor(() => expect(result.current.allTurns).toHaveLength(1));
    revoked = true;
    await act(async () => {
      await result.current.turnsQuery.refetch();
    });
    await waitFor(() => expect(result.current.allTurns).toEqual([]));
    expect(result.current.accessDenied).toBe(true);
  },
);

test("a denied history listing hides its previously looked-up title and prevents writes", async () => {
  let denied = false;
  const { result, fetch } = mount(
    (url) => {
      if (url.pathname.endsWith("/conversations"))
        return denied
          ? Response.json({ code: "not_found", message: "redacted" }, { status: 404 })
          : Response.json({ items: [] });
      if (url.pathname.endsWith("/thread")) return Response.json(conversation);
      return Response.json({ items: [] });
    },
    undefined,
    "thread",
  );
  await waitFor(() => expect(result.current.id).toBe("thread"));
  denied = true;
  await act(async () => {
    await result.current.listing.refetch();
  });
  await waitFor(() => expect(result.current.accessDenied).toBe(true));
  expect(result.current.conversations).toEqual([]);
  await expect(result.current.send({ mode: "chat", prompt: "continue" })).rejects.toBeDefined();
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

test("permission errors from sending recheck the visible history before showing old answers", async () => {
  let revoked = false;
  const { result } = mount((url, init) => {
    if (init?.method === "POST") {
      revoked = true;
      return Response.json({ code: "not_found", message: "private context" }, { status: 404 });
    }
    if (url.pathname.endsWith("/turns"))
      return Response.json({ items: revoked ? [] : [{ prompt: "private" }] });
    return Response.json({ items: [conversation] });
  });
  await waitFor(() => expect(result.current.allTurns).toHaveLength(1));
  await act(async () => {
    await expect(result.current.send({ mode: "chat", prompt: "continue" })).rejects.toBeDefined();
  });
  await waitFor(() => expect(result.current.allTurns).toEqual([]));
});
