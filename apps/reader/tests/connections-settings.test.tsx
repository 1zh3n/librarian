import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";
import { api } from "../src/api/client";
import type { McpGrant, McpSettings } from "../src/api/client";
import { ConnectionsSettings } from "../src/features/settings/ConnectionsSettings";

const settings: McpSettings = {
  enabled: true,
  available: true,
  disabledByEnv: false,
  endpoint: "https://docs.example.test/.mcp",
  publicReaderUrl: "https://docs.example.test",
  publicReaderUrlError: null,
};

const grant: McpGrant = {
  id: "grant-one",
  clientName: "Member app",
  clientKind: "dcr",
  spaces: [{ id: "left", name: "Left" }],
  scope: "mcp",
  createdAt: "2026-11-22T01:00:00Z",
  lastUsedAt: "2026-11-22T01:05:00Z",
};

function renderConnections({
  isAdmin = true,
  active = true,
  setBusy = vi.fn(),
}: {
  isAdmin?: boolean;
  active?: boolean;
  setBusy?: (value: boolean) => void;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConnectionsSettings
        account="ai-review"
        isAdmin={isAdmin}
        active={active}
        busy={false}
        setBusy={setBusy}
      />
    </QueryClientProvider>,
  );
}

let getSettings: MockInstance<typeof api.getMcpSettings>;
let listGrants: MockInstance<typeof api.listMcpGrants>;
let revokeGrant: MockInstance<typeof api.revokeMcpGrant>;

beforeEach(() => {
  getSettings = vi.spyOn(api, "getMcpSettings");
  getSettings.mockResolvedValue(settings);
  listGrants = vi.spyOn(api, "listMcpGrants");
  listGrants.mockResolvedValue([grant]);
  revokeGrant = vi.spyOn(api, "revokeMcpGrant");
  revokeGrant.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("administrators see the service status, endpoint and connected app", async () => {
  renderConnections();
  expect(await screen.findByText("MCP 服务")).toBeTruthy();
  expect(screen.getByText("已启用")).toBeTruthy();
  expect(screen.getByText("https://docs.example.test/.mcp")).toBeTruthy();
  expect(screen.getByRole("button", { name: "停用 MCP" })).toBeTruthy();
  expect(screen.getByText("Member app")).toBeTruthy();
  expect(screen.getByText(/Left/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "撤销" })).toBeTruthy();
});

test("members can read the endpoint and their connections but cannot toggle the service", async () => {
  renderConnections({ isAdmin: false });
  expect(await screen.findByText("MCP 服务")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "停用 MCP" })).toBeNull();
  expect(screen.queryByRole("button", { name: "启用 MCP" })).toBeNull();
  expect(screen.getByText("服务开关由服务器管理员管理。")).toBeTruthy();
  expect(screen.getByText("https://docs.example.test/.mcp")).toBeTruthy();
});

test("a deployment-level MCP shutdown is not presented as an enable action", async () => {
  getSettings.mockResolvedValue({
    ...settings,
    enabled: false,
    available: false,
    disabledByEnv: true,
  });
  renderConnections();
  expect(await screen.findByText("部署关闭")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "启用 MCP" })).toBeNull();
  expect(screen.getByText(/部署参数已关闭 MCP/)).toBeTruthy();
});

test("revoking a connection asks for confirmation and removes it from the list", async () => {
  const setBusy = vi.fn();
  renderConnections({ setBusy });
  fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
  expect(revokeGrant).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "撤销外部 AI 连接" })).toBeTruthy();
  listGrants.mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "确认撤销" }));
  await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith("grant-one"));
  expect(await screen.findByText(/还没有外部 AI 连接/)).toBeTruthy();
  expect(setBusy).toHaveBeenCalledWith(true);
  expect(setBusy).toHaveBeenLastCalledWith(false);
});

test("canceling a revoke keeps the connection and closes the confirmation", async () => {
  renderConnections();
  fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(revokeGrant).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "撤销外部 AI 连接" })).toBeNull(),
  );
  expect(screen.getByText("Member app")).toBeTruthy();
});

test("toggling the service uses the live settings endpoint and updates the status", async () => {
  const setEnabled = vi.spyOn(api, "setMcpEnabled");
  setEnabled.mockResolvedValue({
    ...settings,
    enabled: false,
  });
  renderConnections();
  fireEvent.click(await screen.findByRole("button", { name: "停用 MCP" }));
  await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));
  expect(await screen.findByText("MCP 已关闭。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "启用 MCP" })).toBeTruthy();
});
