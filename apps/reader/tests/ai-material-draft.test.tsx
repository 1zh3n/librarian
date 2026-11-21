import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { listAiMaterials } from "../src/api/client";
import type { AiMaterialView } from "../src/api/client";
import { useMaterialSelection } from "../src/features/ai/AiMaterials";

vi.mock("../src/api/client", async (original) => ({
  ...(await original<typeof import("../src/api/client")>()),
  listAiMaterials: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("restores selected IDs only after checking the current account's conversation receipts", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const visit = {
    username: "reader",
    id: "origin",
    materialIds: ["keep", "removed", "expired", "parsing", "failed"],
  };
  const receipt = (
    id: string,
    status = "ready",
    expiresAt = Date.now() / 1000 + 3600,
  ): AiMaterialView => ({ id, name: id, status, size: 12, expiresAt });
  client.setQueryData(
    ["ai-materials", "origin"],
    visit.materialIds.map((id) => receipt(id)),
  );
  let resolve!: (items: AiMaterialView[]) => void;
  vi.mocked(listAiMaterials).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(
    ({ username, id }) => useMaterialSelection(username, id, visit),
    { wrapper, initialProps: { username: "other", id: "origin" } },
  );
  expect(result.current.selected).toEqual([]);
  rerender({ username: "reader", id: "another" });
  expect(result.current.selected).toEqual([]);
  expect(listAiMaterials).not.toHaveBeenCalled();

  rerender({ username: "reader", id: "origin" });
  expect(result.current.selected).toEqual([]);
  expect(result.current.restoring).toBe(true);
  await waitFor(() => expect(listAiMaterials).toHaveBeenCalledTimes(1));
  await act(async () =>
    resolve([
      receipt("keep"),
      receipt("expired", "ready", 0),
      receipt("parsing", "parsing"),
      receipt("failed", "failed"),
      receipt("unselected"),
    ]),
  );
  await waitFor(() => expect(result.current.selected).toEqual(["keep"]));
  expect(result.current.restoring).toBe(false);
  act(() => result.current.setSelected([]));
  expect(result.current.selected).toEqual([]);
  rerender({ username: "reader", id: "another" });
  rerender({ username: "reader", id: "origin" });
  expect(result.current.selected).toEqual([]);
  client.clear();
});
