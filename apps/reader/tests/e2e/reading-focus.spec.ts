import { expect, test } from "@playwright/test";
import type { DevicePreferences } from "../../src/api/client";
import { createNote, openDocumentTool } from "./productFixture";

const longParagraph = "同一段文字保持换行。沿着湿地栈道观测候鸟和水线。".repeat(110);
const markdown = `## 第一段\n\n${longParagraph}\n\n## 走到桥头\n\n${longParagraph}\n\n最后一段。\n`;

test("focus keeps width, wrapping, and scroll, then restores the layout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createNote(page, "FocusGeometry.md", markdown);
  const reader = page.getByRole("article");
  const viewport = page.getByRole("main");
  const directory = page.getByRole("treegrid", { name: "空间目录" });
  await expect(directory).toBeVisible();
  await openDocumentTool(page, "文档目录");
  const contents = page.getByRole("navigation", { name: "文档目录" });
  await expect(contents).toBeVisible();
  await reader.focus();
  await viewport.evaluate((node) => {
    node.scrollTop = 370;
  });
  const geometry = async () =>
    reader.evaluate((article) => ({
      width: article.getBoundingClientRect().width,
      paragraph: article.querySelector("p")?.getBoundingClientRect().height,
      scroll: article.closest("main")?.scrollTop,
    }));
  const before = await geometry();
  await reader.press("f");
  await expect(page.getByText("专注阅读 · Esc 退出")).toBeVisible();
  await expect(directory).toBeHidden();
  await expect(contents).toBeHidden();
  expect(await geometry()).toEqual(before);
  await reader.press("Escape");
  await expect(directory).toBeVisible();
  await expect(contents).toBeVisible();
  expect(await geometry()).toEqual(before);
});

test("semantic focus groups headings, survives scrolling, and Escape clears it before layout", async ({
  page,
}) => {
  await createNote(page, "SemanticFocus.md", markdown);
  const reader = page.getByRole("article");
  await reader.focus();
  await reader.press("f");
  await reader.press("]");
  const focus = page.getByRole("group", { name: "语义聚焦" });
  await expect(focus).toBeVisible();
  const active = reader.locator("[data-semantic-active]");
  await expect(active).toHaveCount(2);
  await expect(active.first()).toHaveText("第一段");
  const viewport = page.getByRole("main");
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(active.first()).toHaveText("第一段");
  await focus.getByRole("button", { name: "返回焦点" }).click();
  expect(
    await active
      .first()
      .evaluate((node) =>
        Math.abs(
          node.getBoundingClientRect().top -
            (node.closest("main")?.getBoundingClientRect().top ?? 0),
        ),
      ),
  ).toBeLessThan(3);
  await focus.getByRole("button", { name: "下一块" }).click();
  await expect(active.first()).toHaveText("走到桥头");

  await reader.press("Escape");
  await expect(focus).toBeHidden();
  await expect(page.getByRole("treegrid", { name: "空间目录" })).toBeHidden();
  await reader.press("Escape");
  await expect(page.getByRole("treegrid", { name: "空间目录" })).toBeVisible();
});

test("reader shortcuts leave active editors alone and invalid blocks clear safely", async ({
  page,
}) => {
  await createNote(page, "FocusShortcuts.md", markdown);
  const reader = page.getByRole("article");
  await reader.focus();
  await reader.press("]");
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeVisible();

  await reader.press("Alt+e");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+a");
  await page.keyboard.type("f[]");
  await expect(editor).toContainText("f[]");
  await expect(page.getByRole("treegrid", { name: "空间目录" })).toBeVisible();
  await page.getByRole("textbox", { name: "Markdown 正文" }).press("Escape");
  await expect(reader).toContainText("f[]");
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeHidden();
});

test("device preferences survive reload", async ({ page }) => {
  await createNote(page, "Preferences.md", "设备设置测试");
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "应用设置" });
  await settings.getByRole("button", { name: /主题/ }).click();
  await page.getByRole("option", { name: "深色" }).click();
  const eink = settings.getByRole("checkbox", { name: "墨水屏" });
  await eink.press("Space");
  await expect(eink).toBeChecked();
  await settings.getByRole("button", { name: "保存设置" }).click();
  await expect(settings).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-eink", "true");
  await page.reload();
  await expect(page.getByRole("article")).toContainText("设备设置测试");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-eink", "true");
});

test("settings tabs preserve drafts and save values from inactive tabs", async ({ page }) => {
  await createNote(page, "SettingsTabs.md", "设备设置分组");
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "应用设置" });
  const appearance = settings.getByRole("tab", { name: "外观" });
  const reading = settings.getByRole("tab", { name: "阅读与布局" });
  const shortcuts = settings.getByRole("tab", { name: "快捷键" });
  await expect(appearance).toHaveAttribute("aria-selected", "true");
  await settings.getByRole("checkbox", { name: "减少动画" }).press("Space");
  await appearance.press("ArrowRight");
  await expect(reading).toHaveAttribute("aria-selected", "true");
  const fontSize = settings.getByLabel("字号", { exact: true });
  await fontSize.fill("");
  await reading.press("ArrowRight");
  await expect(shortcuts).toHaveAttribute("aria-selected", "true");
  await settings.getByLabel("专注快捷键").fill("g");
  const save = settings.getByRole("button", { name: "保存设置" });
  await save.click();
  await expect(reading).toHaveAttribute("aria-selected", "true");
  await expect(fontSize).toBeFocused();
  await fontSize.fill("23");
  await reading.press("ArrowRight");
  await shortcuts.press("ArrowLeft");
  await expect(fontSize).toHaveValue("23");
  await save.click();
  await expect(settings).toBeHidden();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await expect(page.locator("html")).toHaveCSS("--reading-size", "23px");
  await page.getByRole("article").press("g");
  await expect(page.getByText("专注阅读 · Esc 退出")).toBeVisible();
});

test("selects layout previews and keeps the active tool when resizing the directory", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "LayoutPresets.md", markdown);
  await page.getByRole("button", { name: "搜索文档" }).click();
  await page.getByRole("searchbox").fill("林间回声");
  await page.getByRole("option", { name: /林间回声/ }).click();
  const layout = page.getByRole("button", { name: "布局" });
  const directory = page.getByRole("treegrid", { name: "空间目录" });

  await layout.click();
  await page.getByRole("menuitemradio", { name: "写作布局" }).click();
  await expect(directory).toBeVisible();
  await expect(page.getByRole("tab", { name: "提纲" })).toHaveAttribute("aria-selected", "true");

  await layout.click();
  const research = page.getByRole("menuitemradio", { name: "研究布局" });
  await research.click();
  const ai = page.getByRole("tab", { name: "AI" });
  await expect(ai).toHaveAttribute("aria-selected", "true");
  const message = page.getByRole("textbox", { name: "提示词" });
  await message.fill("保留这条草稿");
  const divider = page.getByRole("separator", { name: "调整空间目录宽度" });
  const previousWidth = (await directory.boundingBox())?.width ?? 0;
  await divider.press("ArrowRight");
  await expect
    .poll(async () => (await directory.boundingBox())?.width ?? 0)
    .toBeGreaterThan(previousWidth);
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await expect(message).toHaveValue("保留这条草稿");
  await layout.click();
  await expect(research).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "引用" }).click();
  await layout.click();
  await research.click();
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await expect(message).toHaveValue("保留这条草稿");

  await page.reload();
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await layout.click();
  await expect(research).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "校订布局" }).click();
  await expect(directory).toBeHidden();
  await expect(page.getByRole("tab", { name: "版本" })).toHaveAttribute("aria-selected", "true");
  await layout.click();
  await page.getByRole("menuitemradio", { name: "阅读布局" }).click();
  await expect(page.getByRole("tablist", { name: "文档工具" })).toBeHidden();
});

test("focus layout follows navigation and the old semantic block clears", async ({ page }) => {
  await createNote(page, "FocusCrossDocument.md", markdown);
  const first = page.getByRole("article");
  await first.focus();
  await first.press("f");
  await first.press("]");
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeVisible();
  await page.getByRole("button", { name: "搜索文档" }).click();
  await page.getByRole("searchbox", { name: "搜索文档" }).fill("河岸清晨");
  await page.getByRole("option", { name: /河岸清晨/ }).click();
  await expect(page.getByRole("heading", { name: "河岸清晨", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeHidden();
  await expect(page.getByRole("treegrid", { name: "空间目录" })).toBeHidden();
  await page.getByRole("article").press("Escape");
  await expect(page.getByRole("treegrid", { name: "空间目录" })).toBeVisible();
});

test("changing the layout during a reload keeps saved appearance preferences", async ({ page }) => {
  const { origin } = await createNote(page, "PreferencesRace.md", "保留外观");
  await expect(page.getByRole("article")).toContainText("保留外观");
  const deviceId = await page.evaluate(() => window.localStorage.getItem("librarian.device"));
  const endpoint = `/api/v1/settings/devices/${deviceId ?? ""}`;
  const get = async () => (await (await page.request.get(endpoint)).json()) as DevicePreferences;
  const previous = await get();
  const saved = await page.request.put(endpoint, {
    headers: { origin },
    data: { ...previous, theme: "dark", eink: true, fontSize: 23 },
  });
  expect(saved.ok()).toBe(true);

  let release = () => {};
  const initial = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route(`**${endpoint}`, async (route) => {
    if (!held && route.request().method() === "GET") {
      held = true;
      await initial;
    }
    await route.continue();
  });
  await page.reload();
  try {
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "收起目录" }).click();
    await expect.poll(async () => (await get()).navigation).toBe(false);
    expect(await get()).toMatchObject({ theme: "dark", eink: true, fontSize: 23 });
  } finally {
    release();
  }
});

test("focus keeps the narrow reading position when an inline tool closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await createNote(page, "NarrowFocus.md", markdown);
  const reader = page.getByRole("article");
  await openDocumentTool(page, "文档目录");
  await expect(page.getByRole("navigation", { name: "文档目录" })).toBeVisible();
  await reader.focus();
  const firstHeading = reader.getByRole("heading", { name: "第一段" });
  const position = () => firstHeading.evaluate((heading) => heading.getBoundingClientRect().top);
  const original = await position();
  await reader.press("f");
  await expect(page.getByRole("navigation", { name: "文档目录" })).toBeHidden();
  expect(Math.abs((await position()) - original)).toBeLessThan(1);
  await reader.press("Escape");
  await expect(page.getByRole("navigation", { name: "文档目录" })).toBeVisible();
  expect(Math.abs((await position()) - original)).toBeLessThan(1);
});

test("inserting an identical block earlier never moves semantic focus to the wrong duplicate", async ({
  page,
}) => {
  await createNote(page, "RepeatedFocus.md", "重复。\n\n重复。\n\n末段。\n");
  const reader = page.getByRole("article");
  await reader.focus();
  await reader.press("]");
  await reader.press("]");
  const anchored = reader.locator("[data-semantic-active]");
  await expect(anchored).toHaveAttribute("data-block-id", /-2$/);
  await reader.press("Alt+e");
  await page.getByRole("textbox", { name: "Markdown 正文" }).press("Control+Home");
  await page.keyboard.insertText("重复。\n\n");
  await page.getByRole("textbox", { name: "Markdown 正文" }).press("Escape");
  await expect(reader.getByText("重复。", { exact: true })).toHaveCount(3);
  await expect(anchored).toHaveCount(0);
});

test("search dismissal and the settings command restore the original reading position and focus", async ({
  page,
}) => {
  await createNote(page, "SearchResume.md", markdown);
  const reader = page.getByRole("article");
  const main = page.getByRole("main");
  await reader.focus();
  await main.evaluate((node) => (node.scrollTop = 430));

  const palette = page.getByRole("dialog", { name: "快速打开与全文搜索" });
  await reader.press("Control+k");
  const input = palette.getByRole("searchbox");
  await input.fill("没有这份湿地记录");
  await expect(palette.getByText("未找到文档")).toBeVisible();
  await input.press("Escape");
  await expect(palette).toBeHidden();
  await expect(reader).toBeFocused();
  expect(await main.evaluate((node) => node.scrollTop)).toBe(430);

  await reader.press("Control+k");
  await input.fill("设置");
  await palette.getByRole("option", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "应用设置" });
  await expect(settings.getByRole("tab", { name: "外观" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(reader).toBeFocused();
  expect(await main.evaluate((node) => node.scrollTop)).toBe(430);
});

test("topbar settings keep an edit draft and leave layout presets together", async ({ page }) => {
  await createNote(page, "SettingsReturn.md", "文稿正文。");
  const bar = page.getByRole("banner");
  await bar.getByRole("button", { name: "布局", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  await expect(menu.getByRole("menuitem", { name: /设置/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("article").press("Alt+e");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+End");
  await page.keyboard.insertText("保留编辑位置。");
  const button = bar.getByRole("button", { name: "设置", exact: true });
  await button.click();
  const settings = page.getByRole("dialog", { name: "应用设置" });
  await settings.getByRole("button", { name: "取消" }).click();
  await expect(button).toBeFocused();
  const reader = page.getByRole("article");
  await expect(reader).toContainText("保留编辑位置。");
  await reader.press("Alt+e");
  await expect(editor).toContainText("保留编辑位置。");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("保留编辑位置。");
});

test("settings retry a failed initial load before exposing a draft of the existing preferences", async ({
  page,
}) => {
  const { origin } = await createNote(page, "SettingsInitialRead.md", "已有设备偏好。");
  await expect(page.getByRole("article")).toContainText("已有设备偏好");
  const device = await page.evaluate(() => localStorage.getItem("librarian.device"));
  const endpoint = `/api/v1/settings/devices/${device}`;
  const current = (await (await page.request.get(endpoint)).json()) as DevicePreferences;
  const saved = await page.request.put(endpoint, {
    headers: { origin },
    data: { ...current, fontSize: 23 },
  });
  expect(saved.ok()).toBe(true);

  let release = () => {};
  const initial = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**${endpoint}`,
    async (route) => {
      await initial;
      await route.fulfill({ status: 503 });
    },
    { times: 1 },
  );
  await page.reload();
  const button = page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
  await button.click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  try {
    await expect(dialog.getByRole("status")).toContainText("正在读取设备设置");
    await expect(dialog.getByRole("button", { name: "保存设置" })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(dialog.getByRole("alert")).toContainText("无法读取设备设置");
  await dialog.getByRole("button", { name: "重试" }).click();
  await dialog.getByRole("tab", { name: "阅读与布局" }).click();
  await expect(dialog.getByLabel("字号", { exact: true })).toHaveValue("23");
  await dialog.getByRole("button", { name: "保存设置" }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
});
