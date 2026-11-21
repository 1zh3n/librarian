import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { api, ApiError } from "../src/api/client";
import { RecentlyDeletedDialog } from "../src/features/navigation/RecentlyDeletedDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("cancelling a conflicting restore returns to the precise record when two names match", async () => {
  vi.spyOn(api, "deletedFileActions").mockResolvedValue({
    items: [
      { operationId: "a", path: "一组/录音.md", sourceKind: "document", fileCount: 1 },
      { operationId: "b", path: "二组/录音.md", sourceKind: "document", fileCount: 1 },
    ],
  });
  vi.spyOn(api, "folders").mockResolvedValue({ folders: ["一组", "二组"], identities: {} });
  const restore = vi.fn().mockRejectedValue(new ApiError(409, "path_exists", "occupied"));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecentlyDeletedDialog
        workspace="field"
        conflict={undefined}
        restore={restore}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  const item = (await screen.findByText("二组/录音.md")).closest("li")!;
  fireEvent.click(within(item).getByRole("button", { name: "恢复" }));
  await screen.findByRole("dialog", { name: "选择恢复位置" });
  expect(restore).toHaveBeenCalledWith("b", undefined);
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "另一段录音" },
  });
  fireEvent.click(screen.getByRole("button", { name: "恢复到此处" }));
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(restore).toHaveBeenLastCalledWith("b", "二组/另一段录音.md");
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "第三段录音" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
  const restoredRow = (await screen.findByText("二组/录音.md")).closest("li")!;
  await waitFor(() =>
    expect(document.activeElement).toBe(within(restoredRow).getByRole("button", { name: "恢复" })),
  );
});

test("shows the actual fallback when the old parent is occupied and rejects outline names", async () => {
  vi.spyOn(api, "deletedFileActions").mockResolvedValue({
    items: [{ operationId: "b", path: "旧目录/记录.md", sourceKind: "document", fileCount: 1 }],
  });
  vi.spyOn(api, "folders").mockResolvedValue({ folders: [], identities: {} });
  const restore = vi.fn().mockRejectedValue(new ApiError(409, "path_exists", "occupied"));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecentlyDeletedDialog
        workspace="field"
        conflict={{ id: "b", reason: "occupied" }}
        restore={restore}
        close={() => {}}
      />
    </QueryClientProvider>,
  );
  const field = await screen.findByRole("textbox", { name: /名称/u });
  const picker = screen.getByRole("button", { name: /目标目录/u });
  await waitFor(() => expect(picker.textContent).toContain("根目录"));
  fireEvent.change(field, { target: { value: "记录.outline.md" } });
  const submit = screen.getByRole("button", { name: "恢复到此处" });
  expect(submit.hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "记录副本" } });
  fireEvent.click(submit);
  await waitFor(() => expect(restore).toHaveBeenCalledWith("b", "记录副本.md"));
});
