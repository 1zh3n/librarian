import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import * as sdk from "../src/api/client";
import { AiSettings } from "../src/features/settings/AiSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("activation refreshes the open connection and saves a pending rename at the new version", async () => {
  const connection: sdk.AiConnection = {
    id: "field",
    label: "田野",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    hasApiKey: true,
    enabled: false,
    version: 7,
    models: [{ id: "field-model" }],
    fetchedAt: Math.floor(Date.now() / 1000),
  };
  let view: sdk.AiSettingsView = {
    settingsVersion: 3,
    globalEnabled: true,
    runnerOnline: true,
    dispatchMode: "legacy",
    connections: [connection],
    defaultSelection: null,
    effectiveSelection: null,
    preference: null,
    fallbackReason: null,
  };
  vi.spyOn(sdk, "getAiSettings").mockImplementation(async () => view);
  vi.spyOn(sdk, "activateManagedAi").mockImplementation(async ({ activationId, selection }) => {
    view = {
      ...view,
      settingsVersion: 4,
      dispatchMode: "managed",
      connections: [{ ...connection, enabled: true, version: 8 }],
      defaultSelection: selection,
      effectiveSelection: selection,
    };
    return { activationId };
  });
  const patch = vi.spyOn(sdk, "updateAiConnection").mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AiSettings active isAdmin username="admin" busy={false} setBusy={() => {}} />
    </QueryClientProvider>,
  );

  await screen.findByRole("button", { name: "启用连接" });
  const draft = "尚未保存的连接名";
  fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "启用受管 AI" }));
  fireEvent.click(screen.getByRole("button", { name: "确认启用受管 AI" }));
  await screen.findByText("受管 AI 已启用。");
  await screen.findByRole("button", { name: "停用连接" });
  expect(screen.getByDisplayValue(draft)).toBe(screen.getByRole("textbox", { name: "连接名称" }));
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("field", {
      expectedVersion: 8,
      label: draft,
      keyChange: { kind: "keep" },
    }),
  );
});
