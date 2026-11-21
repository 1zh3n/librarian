import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { DevicePreferences } from "../../src/api/client";
import { createNote, openDocumentTool } from "./productFixture";

async function bounds(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Expected a visible dock panel");
  return rect;
}

async function deviceSettings(page: Page) {
  const device = await page.evaluate(() => localStorage.getItem("librarian.device"));
  return (await (
    await page.request.get(`/api/v1/settings/devices/${device}`)
  ).json()) as DevicePreferences;
}

test("collapsing the directory by its divider remembers visibility and the last usable width", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "分栏记忆.md", "收起目录后继续阅读。");
  const divider = page.getByRole("separator", { name: "调整空间目录宽度" });
  const navigation = page.locator("#workspace-navigation");
  const original = await bounds(navigation);
  await divider.press("ArrowRight");
  await expect
    .poll(async () => (await deviceSettings(page)).sidebarWidth)
    .toBeGreaterThan(original.width);
  const width = Math.round((await bounds(navigation)).width);
  const handle = await bounds(divider);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(0, handle.y + 80, { steps: 10 });
  await page.mouse.up();
  const expand = page.getByRole("button", { name: "展开目录" });
  await expect(expand).toBeFocused();
  await expect.poll(async () => (await deviceSettings(page)).navigation).toBe(false);
  await page.reload();
  await expand.click();
  await expect.poll(async () => Math.round((await bounds(navigation)).width)).toBe(width);
  await info.attach("directory-widths", {
    body: JSON.stringify({
      initial: original.width,
      resized: width,
      reopened: Math.round((await bounds(navigation)).width),
    }),
    contentType: "application/json",
  });
});

test("resizes document tools from their visible width and saves only completed adjustments", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { origin } = await createNote(page, "文档辅助区宽度.md", "比较同一篇文档并保留提示词。");
  await expect(page.getByRole("article")).toContainText("比较同一篇文档并保留提示词。");
  const device = await page.evaluate(() => localStorage.getItem("librarian.device"));
  const previous = await deviceSettings(page);
  const preference = await page.request.put(`/api/v1/settings/devices/${device}`, {
    headers: { origin },
    data: { ...previous, toolsWidth: 480 },
  });
  expect(preference.ok()).toBe(true);
  await page.reload();
  await openDocumentTool(page, "AI");
  const handle = page.getByRole("separator", { name: "调整文档辅助区宽度" });
  await expect(handle).toBeVisible();
  const pane = page.getByRole("region", { name: "文档辅助区", exact: true });
  const initial = Math.round((await bounds(pane)).width);
  const draft = page.getByRole("textbox", { name: "提示词" });
  await draft.fill("请核对这段笔记");
  await handle.press("End");
  const capped = Math.round((await bounds(pane)).width);
  expect(capped).toBe(initial);
  expect((await deviceSettings(page)).toolsWidth).toBe(480);
  expect(capped).toBeLessThan(480);
  await handle.press("ArrowRight");
  await expect.poll(async () => (await deviceSettings(page)).toolsWidth).toBe(capped - 16);
  const saved = capped - 16;
  const rect = await bounds(handle);
  const x = rect.x + rect.width / 2;
  const y = rect.y + 45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y);
  await expect.poll(async () => Math.round((await bounds(pane)).width)).toBe(saved - 24);
  expect((await deviceSettings(page)).toolsWidth).toBe(saved);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(handle).toBeVisible();
  await expect.poll(async () => Math.round((await bounds(pane)).width)).toBe(saved);
  expect((await deviceSettings(page)).toolsWidth).toBe(saved);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y);
  await page.mouse.up();
  await expect.poll(async () => (await deviceSettings(page)).toolsWidth).toBe(saved - 24);
  await expect(draft).toHaveValue("请核对这段笔记");
  await page.screenshot({ path: info.outputPath("desktop-tools.png") });
  await page.reload();
  await openDocumentTool(page, "AI");
  await expect.poll(async () => Math.round((await bounds(pane)).width)).toBe(saved - 24);
  await info.attach("tool-widths", {
    body: JSON.stringify({
      initial,
      capped,
      keyboard: saved,
      afterReload: Math.round((await bounds(pane)).width),
    }),
    contentType: "application/json",
  });
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(handle).toBeHidden();
    expect((await deviceSettings(page)).toolsWidth).toBe(saved - 24);
  }

  await page.setViewportSize({ width: 1920, height: 900 });
  await expect(handle).toBeVisible();
  const before = await bounds(pane);
  await handle.press("ArrowRight");
  const after = await bounds(pane);
  expect(after.x - before.x).toBeCloseTo(16, 0);
  expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);
  await expect
    .poll(async () => (await deviceSettings(page)).toolsWidth)
    .toBe(Math.round(after.width));
  await handle.press("Home");
  await expect.poll(async () => (await deviceSettings(page)).toolsWidth).toBe(200);
  await handle.press("End");
  const max = Number(await handle.getAttribute("aria-valuemax"));
  await expect.poll(async () => (await deviceSettings(page)).toolsWidth).toBe(max);
});

test("hiding the tool divider cancels a drag still held across the narrow breakpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "拖动时转为窄屏.md", "继续同一篇文档");
  await openDocumentTool(page, "AI");
  const pane = page.getByRole("region", { name: "文档辅助区", exact: true });
  const handle = page.getByRole("separator", { name: "调整文档辅助区宽度" });
  const initial = (await deviceSettings(page)).toolsWidth;
  const rect = await bounds(handle);
  const x = rect.x + rect.width / 2;
  const y = rect.y + 28;
  const writes: number[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/settings/devices/")) {
      writes.push((request.postDataJSON() as DevicePreferences).toolsWidth);
    }
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 24, y);
  await expect.poll(async () => Math.round((await bounds(pane)).width)).toBe(initial + 24);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle).toBeHidden();
  await page.mouse.up();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.round((await bounds(pane)).width)).toBe(initial);
  expect(writes).toEqual([]);
  expect((await deviceSettings(page)).toolsWidth).toBe(initial);
});
