import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { expandAdminSections } from "./aiSettingsFixture";
import { signIn } from "./productFixture";

const enabled = {
  enabled: true,
  available: true,
  disabledByEnv: false,
  endpoint: "https://192.168.8.166:18447/.mcp",
  publicReaderUrl: "https://192.168.8.166:18447",
  publicReaderUrlError: null,
};

const trigger = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
const settings = (page: Page) => page.getByRole("dialog", { name: "应用设置" });

function modalHeight(page: Page) {
  return settings(page).evaluate((element) => {
    const container = element.closest<HTMLElement>('[data-slot="modal-container"]');
    return container?.offsetHeight ?? 0;
  });
}

async function mockMcp(page: Page) {
  await page.route("**/api/v1/mcp/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/mcp/settings")) return route.fulfill({ json: enabled });
    if (path.endsWith("/mcp/grants")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 204 });
  });
}

test("settings keep one height while tabs and AI sections change", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  await mockMcp(page);
  await trigger(page).click();
  const dialog = settings(page);
  const appearanceHeight = await modalHeight(page);
  expect(appearanceHeight).toBeGreaterThan(400);

  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(dialog.getByText("我的模型")).toBeVisible();
  const aiHeight = await modalHeight(page);
  expect(Math.abs(aiHeight - appearanceHeight)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("settings-ai-1440.png") });

  const connectionSection = dialog.getByRole("button", {
    name: /连接配置/,
  });
  await expect(connectionSection).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeHidden();
  await connectionSection.click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
  await connectionSection.click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeHidden();
  await connectionSection.click();
  await expect(dialog.getByLabel("API Key", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /全局 AI 与执行器/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await dialog.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "MCP 服务" })).toBeVisible();
  const connectionsHeight = await modalHeight(page);
  expect(Math.abs(connectionsHeight - appearanceHeight)).toBeLessThanOrEqual(1);

  await dialog.getByRole("tab", { name: "快捷键", exact: true }).click();
  const shortcutsHeight = await modalHeight(page);
  expect(Math.abs(shortcutsHeight - appearanceHeight)).toBeLessThanOrEqual(1);
});

test("the model capability block is collapsed until requested", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  await page.route("**/api/v1/ai/settings/discover", (route) =>
    route.fulfill({
      json: {
        discoveryId: "fixture-ticket",
        fetchedAt: 1_795_219_200,
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek-V4.1-Flash",
            inputModalities: ["text", "image"],
            outputModalities: ["text"],
            contextWindow: 1_048_576,
            maxOutputTokens: 393_216,
            effort: { supportedLevels: ["low", "high", "max"], defaultLevel: "high" },
          },
        ],
      },
    }),
  );
  await trigger(page).click();
  const dialog = settings(page);
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  await expandAdminSections(dialog);
  await dialog.getByLabel("API Key", { exact: true }).fill("fixture-key");
  await dialog.getByRole("button", { name: "刷新模型" }).click();
  const capability = dialog.getByRole("button", { name: /模型能力/ });
  await expect(capability).toBeVisible();
  await expect(dialog.getByText("1,048,576 tokens")).toBeHidden();
  await capability.click();
  await expect(dialog.getByText("1,048,576 tokens")).toBeVisible();
  await expect(dialog.getByText("393,216 tokens")).toBeVisible();
});
