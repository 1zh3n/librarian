import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

type McpSettings = {
  enabled: boolean;
  available: boolean;
  disabledByEnv: boolean;
  endpoint: string;
  publicReaderUrl: string | null;
  publicReaderUrlError: string | null;
};

type McpGrant = {
  id: string;
  clientName: string;
  clientKind: "cimd" | "dcr";
  spaces: { id: string; name: string }[];
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const endpoint = "https://docs.example.test/.mcp";

const enabled: McpSettings = {
  enabled: true,
  available: true,
  disabledByEnv: false,
  endpoint,
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

async function login(page: Page, username: string, password: string) {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}

const trigger = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "应用设置" });

async function openConnections(page: Page) {
  await trigger(page).click();
  const settings = dialog(page);
  const tab = settings.getByRole("tab", { name: "连接", exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  return settings;
}

async function mockMcp(page: Page, state: { settings: McpSettings; grants: McpGrant[] }) {
  await page.route("**/api/v1/mcp/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/mcp/settings")) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { enabled: boolean };
        state.settings = { ...state.settings, enabled: body.enabled };
      }
      return route.fulfill({ json: state.settings });
    }
    if (path.endsWith("/mcp/grants")) {
      return route.fulfill({ json: state.grants });
    }
    if (path.includes("/mcp/grants/") && request.method() === "DELETE") {
      const id = path.split("/").at(-1);
      state.grants = state.grants.filter((item) => item.id !== id);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
}

test("administrator enables and disables MCP without restarting", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "fixture-admin", "fixture-admin-test-password");
  const state = { settings: enabled, grants: [grant] };
  await mockMcp(page, state);
  const settings = await openConnections(page);
  await expect(settings.getByRole("heading", { name: "MCP 服务" })).toBeVisible();
  await expect(settings.getByText("已启用")).toBeVisible();
  await expect(settings.getByText(endpoint, { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "停用 MCP" })).toBeVisible();
  await expect(settings.getByText("Member app")).toBeVisible();
  await expect(settings.getByText(/codex mcp add/)).toBeHidden();
  await settings.getByRole("button", { name: "其他客户端", exact: true }).click();
  await expect(settings.getByText(/codex mcp add/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-connections-1440.png"),
  });
  await settings.getByRole("button", { name: "停用 MCP" }).click();
  await expect(settings.getByText("已关闭", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "启用 MCP" })).toBeVisible();
});

test("member sees the endpoint and own connections, not the service toggle", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "reader", "reader-test-password");
  const state = { settings: enabled, grants: [grant] };
  await mockMcp(page, state);
  const settings = await openConnections(page);
  await expect(settings.getByRole("heading", { name: "MCP 服务" })).toBeVisible();
  await expect(settings.getByText(endpoint, { exact: true })).toBeVisible();
  await expect(settings.getByText("服务开关由服务器管理员管理。")).toBeVisible();
  await expect(settings.getByRole("button", { name: "启用 MCP" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "停用 MCP" })).toHaveCount(0);
  await expect(settings.getByText("Member app")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("member-connections-390.png"),
  });
});

test("revoking a connection confirms, removes it and returns focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "reader", "reader-test-password");
  const state = { settings: enabled, grants: [grant] };
  await mockMcp(page, state);
  const settings = await openConnections(page);
  await settings.getByRole("button", { name: "撤销" }).click();
  const confirm = page.getByRole("dialog", { name: "撤销外部 AI 连接" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText("Member app")).toBeVisible();
  await confirm.getByRole("button", { name: "确认撤销" }).click();
  await expect(settings.getByText("还没有外部 AI 连接。")).toBeVisible();
  await expect(settings.getByRole("heading", { name: "已连接应用" })).toBeFocused();
});

test("the connection panel reflows at 320px with 200% text", async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "200% text rendering is verified in Chromium");
  await page.setViewportSize({ width: 320, height: 720 });
  await login(page, "fixture-admin", "fixture-admin-test-password");
  await page.addStyleTag({ content: "html{font-size:32px}" });
  const state = { settings: enabled, grants: [grant] };
  await mockMcp(page, state);
  const settings = await openConnections(page);
  await expect(settings.getByRole("heading", { name: "MCP 服务" })).toBeVisible();
  const box = await settings.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  await expect(settings.getByRole("button", { name: "撤销" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("connections-320-200.png"),
  });
});

test("deployment-level shutdown has no enable action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "fixture-admin", "fixture-admin-test-password");
  const state = {
    settings: {
      ...enabled,
      enabled: false,
      available: false,
      disabledByEnv: true,
    },
    grants: [],
  };
  await mockMcp(page, state);
  const settings = await openConnections(page);
  await expect(settings.getByText("部署关闭")).toBeVisible();
  await expect(settings.getByRole("button", { name: "启用 MCP" })).toHaveCount(0);
  await expect(settings.getByText(/部署参数已关闭 MCP/)).toBeVisible();
});
