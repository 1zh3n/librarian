import { expect, test } from "@playwright/test";
import { createNote, openDocumentTool, signIn } from "./productFixture";

test("settings and reader controls use the desktop scale", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  await expect(dialog).toBeVisible();
  const width = await dialog.evaluate((node) => node.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(680);
  expect(width).toBeLessThanOrEqual(720);
  await expect(dialog.getByRole("tab")).toHaveCount(4);
  await expect(dialog.getByRole("button", { name: "保存设置" })).toHaveCount(0);
  const size = dialog.getByLabel("字号", { exact: true });
  expect(await size.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBe(36);
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  const connections = dialog.getByRole("button", { name: /连接配置/ });
  await expect(connections).toHaveAttribute("aria-expanded", "false");
});

test("document AI exposes starters, the runner and the tool scale", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "UiSystemAi.md", "# 系统门禁\n\n连续阅读正文。\n");
  const tool = page.getByRole("button", { name: "打开文档辅助区" });
  expect(await tool.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBe(36);
  await openDocumentTool(page, "AI");
  const panel = page.getByRole("region", { name: "文档 AI" });
  await expect(panel.getByText("可以让 AI 做这些")).toBeVisible();
  await expect(panel.getByText("现有执行器", { exact: true })).toBeVisible();
  const shell = page.locator("[data-document-ai-panel]");
  const box = await shell.boundingBox();
  expect(box?.width).toBe(336);
  expect(box?.height).toBe(766);
});

test("command palette rows show typed icons at the shared row height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "UiSystemCommand.md", "# 命令门禁\n\n正文。\n");
  await page.getByRole("banner").getByRole("button", { name: "搜索文档" }).click();
  const dialog = page.getByRole("dialog", { name: "快速打开与全文搜索" });
  await dialog.getByRole("searchbox").fill("设置");
  const option = dialog.getByRole("option", { name: "设置", exact: true });
  await expect(option).toBeVisible();
  await expect(option.locator('[data-icon="settings"] svg')).toBeVisible();
  expect(await option.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBe(36);
});
