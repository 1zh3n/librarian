import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Workspace } from "../src/api/client";
import { WorkspaceSecurity } from "../src/features/workspace/WorkspaceSecurity";

afterEach(cleanup);

const workspace: Workspace = {
  id: "security",
  name: "合同资料",
  spaceId: "security",
  origin: "native",
  retention: "persistent",
  revisionMode: "managed",
  defaults: { outlineEnabled: false },
  canWrite: true,
  canManage: true,
  expiresAt: null,
  securityLevel: "confidential",
  capabilities: {
    externalAi: false,
    externalMcp: false,
    anonymousShare: false,
    publication: false,
    offline: false,
    remoteBackup: true,
  },
};

function renderSecurity() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceSecurity workspace={workspace} />
    </QueryClientProvider>,
  );
}

test("shows the current level and the disabled external capabilities", () => {
  renderSecurity();
  expect(screen.getAllByText("受限").length).toBeGreaterThan(0);
  expect(screen.getByText("外部 AI").parentElement?.textContent).toContain("关闭");
  expect(screen.getByText("外部 MCP").parentElement?.textContent).toContain("关闭");
  expect(screen.getByText("匿名分享").parentElement?.textContent).toContain("关闭");
  expect(screen.getByText("远端 Git 备份").parentElement?.textContent).toContain("仅加密目标");
  const save = screen.getByRole("button", { name: "保存安全等级" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
});

test("does not claim the level was saved before a change", () => {
  renderSecurity();
  expect(screen.queryByText("安全等级已保存")).toBeNull();
});
