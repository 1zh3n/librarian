import type { Locator, Page } from "@playwright/test";
import { openFieldWorkspace } from "./productFixture";

export const endpoint = "**/api/v1/ai/settings";
export const official = "https://api.deepseek.com";
export const models = [
  { id: "field-model", effort: { supportedLevels: ["light", "heavy"], defaultLevel: "light" } },
];
export const saved = {
  id: "field",
  label: "田野模型",
  provider: "deepseek" as const,
  baseUrl: official,
  enabled: true,
  hasApiKey: true,
  credentialAvailable: true,
  version: 7,
  models,
  fetchedAt: Math.floor(Date.now() / 1000),
};
export const selection = {
  connectionId: "field",
  modelId: "field-model",
  thinking: { mode: "effort", level: "heavy" },
};
export const snapshot = {
  settingsVersion: 3,
  globalEnabled: true,
  dispatchMode: "legacy",
  connections: [saved],
  defaultSelection: null,
  effectiveSelection: null,
  preference: null,
  fallbackReason: null,
  runnerOnline: true,
};

export async function openSettings(page: Page, admin = true) {
  if (admin) {
    await page.goto("/.auth/librarian/login");
    await page.getByLabel("用户名").fill("fixture-admin");
    await page.getByLabel("密码", { exact: true }).fill("fixture-admin-test-password");
    await page.getByRole("button", { name: "登录" }).click();
  } else {
    await openFieldWorkspace(page);
  }
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  await expandAdminSections(dialog);
  return dialog;
}

export async function expandAdminSections(dialog: Locator) {
  await dialog.getByText("我的模型").waitFor({ state: "visible" });
  for (const name of [/连接配置/, /全局 AI 与执行器/]) {
    const trigger = dialog.getByRole("button", { name });
    if ((await trigger.count()) === 0) continue;
    if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
  }
}
