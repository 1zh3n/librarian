import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createNote } from "./productFixture";

const panel = (page: Page) => page.getByRole("region", { name: "文档 AI", exact: true });
const shell = (page: Page) => page.locator("[data-document-ai-panel]");

async function box(page: Page) {
  const rect = await shell(page).boundingBox();
  if (!rect) throw new Error("Expected the document AI panel");
  return rect;
}

test("floats, drags, resizes, remembers and resets the document AI panel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "浮动文档 AI.md", "对话期间继续读这一段。");
  const launcher = page.getByRole("button", { name: "打开文档 AI" });
  await launcher.click();
  await expect(panel(page)).toBeVisible();

  const initial = await box(page);
  expect(initial.width).toBe(336);
  expect(initial.height).toBe(766);
  expect(initial.x).toBeGreaterThan(720);
  expect(initial.x + initial.width).toBeLessThanOrEqual(1424);
  expect(initial.y).toBeGreaterThan(80);

  await page.mouse.move(initial.x + 80, initial.y + 18);
  await page.mouse.down();
  await page.mouse.move(initial.x - 40, initial.y - 22, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await box(page)).x)).toBe(Math.round(initial.x - 120));
  const dragged = await box(page);
  expect(Math.round(dragged.y)).toBe(Math.round(initial.y - 40));

  const resize = page.getByRole("button", { name: "调整文档 AI 宽度" });
  const handle = await resize.boundingBox();
  if (!handle) throw new Error("Expected the resize handle");
  await page.mouse.move(handle.x + 3, handle.y + 40);
  await page.mouse.down();
  await page.mouse.move(handle.x + 43, handle.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(376);
  await resize.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(360);
  const resized = await box(page);

  await page.reload();
  await expect(page.getByRole("article")).toBeVisible();
  await launcher.click();
  await expect.poll(async () => Math.round((await box(page)).width)).toBe(360);
  const restored = await box(page);
  expect(Math.round(restored.x)).toBe(Math.round(resized.x));
  expect(Math.round(restored.y)).toBe(Math.round(resized.y));

  await page.getByRole("button", { name: "复位文档 AI" }).click();
  const reset = await box(page);
  expect(reset.width).toBe(336);
  expect(reset.height).toBe(766);
  expect(Math.round(reset.x)).toBe(1088);
  await page.getByRole("button", { name: "收起文档 AI" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("document AI fills a phone screen without a resize handle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createNote(page, "手机文档 AI.md", "手机上继续阅读。");
  await page.getByRole("button", { name: "打开文档 AI" }).click();
  await expect(panel(page)).toBeVisible();
  const full = await box(page);
  expect(Math.round(full.x)).toBe(0);
  expect(Math.round(full.y)).toBe(0);
  expect(Math.round(full.width)).toBe(390);
  expect(Math.round(full.height)).toBe(844);
  await expect(page.getByRole("button", { name: "调整文档 AI 宽度" })).toBeHidden();
  await expect(page.getByRole("button", { name: "收起文档 AI" })).toBeVisible();
  await page.getByRole("button", { name: "收起文档 AI" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "打开文档 AI" })).toBeFocused();
});
