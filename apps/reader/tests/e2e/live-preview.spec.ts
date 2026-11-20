import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function enterEditor(page: Page) {
  await page.getByRole("button", { name: "编辑正文" }).click();
  return page.getByRole("textbox", { name: "Markdown 正文" });
}

test("reveals_markdown_under_cursor", async ({ page }) => {
  await page.goto("/");
  const editor = await enterEditor(page);
  await editor.press("Control+End");
  await expect(editor.locator("strong")).toHaveText("安静");
  await editor.locator("strong").click();
  await expect(editor).toContainText("**安静**");
  await editor.press("Control+Home");
  await expect(editor.locator("strong")).toHaveText("安静");
  await expect(editor).not.toContainText("**安静**");
});

test("source_mode_keeps_history", async ({ page }) => {
  await page.goto("/");
  const editor = await enterEditor(page);
  await editor.press("End");
  await page.keyboard.insertText("与潮汐");
  await page.getByRole("button", { name: "完整源码" }).click();
  await expect(editor).toContainText("# 河边的笔记与潮汐");
  await expect(editor).toContainText("**安静**");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("与潮汐");
  await editor.press("Control+Shift+z");
  await expect(editor).toContainText("与潮汐");
  await page.getByRole("button", { name: "即时预览" }).click();
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect(page.getByRole("heading", { name: "河边的笔记与潮汐" })).toBeVisible();
});

test("commonmark_and_gfm_fixture_agree", async ({ page }) => {
  await page.goto("/");
  const reading = page.getByRole("article", { name: "测试文档" });
  await expect(reading.getByRole("table").getByRole("cell", { name: "石桥" })).toBeVisible();
  await expect(reading.getByRole("checkbox").first()).toBeChecked();
  await expect(reading.getByRole("link", { name: "小径" })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  await expect(reading.locator("pre")).toContainText("潮水退了。");

  const editor = await enterEditor(page);
  await editor.press("ArrowDown");
  await expect(editor.getByRole("button", { name: "Front Matter" })).toBeVisible();
  await expect(editor.locator("[data-preview-heading]")).toContainText("河边的笔记");
  await expect(editor.locator("strong")).toHaveText("安静");
  await expect(editor.locator("[data-preview-link]")).toHaveText("小径");
  await expect(editor.locator("[data-preview-list]")).toHaveText(["•", "•"]);
  await expect(editor.locator("[data-preview-task=checked]")).toBeVisible();
  await expect(editor.locator("[data-preview-quote]")).toContainText("别惊动停在芦苇里的鸟。");
  const table = editor.getByRole("table");
  await expect(table.getByRole("cell", { name: "石桥" })).toBeVisible();
  await expect(editor.locator("[data-preview-code]", { hasText: "潮水退了。" })).toBeVisible();
  await table.press("Enter");
  await expect(editor).toContainText("| 地点 | 水位 |");
});

test("composition_does_not_replace_active_range", async ({ page }) => {
  await page.goto("/");
  const editor = await enterEditor(page);
  await editor.locator("strong").click();
  await expect(editor).toContainText("**安静**");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
  await expect(editor).toContainText("中");
  await expect(editor).toContainText("**");
  await cdp.send("Input.insertText", { text: "中文" });
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect(page.getByRole("article").locator("strong")).toContainText("中文");
});
