import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { createNote, openDocumentTool } from "./productFixture";

async function expectIcon(control: Locator, name: string) {
  const icon = control.locator(`[data-icon="${name}"]`);
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("pointer-events", "none");
  await expect(icon.locator("svg")).toBeVisible();
}

test("the login mark renders under the authentication page's image restrictions", async ({
  page,
}) => {
  const blockedImages: string[] = [];
  page.on("console", (message) => {
    if (
      message.text().includes("Loading the image") &&
      message.text().includes("Content Security Policy")
    ) {
      blockedImages.push(message.text());
    }
  });
  await page.goto("/.auth/librarian/login");
  await expect(page.getByRole("heading", { name: "登录 Librarian" })).toBeVisible();
  await expectIcon(page.getByRole("main"), "book-open");
  expect(blockedImages).toEqual([]);
});

test("directory and toolbar icons follow their controls without changing document text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "图标样本/符号.md", "# 符号\n\n原文 • ▸ ✓ ⚙");
  await expect(page.getByRole("article")).toContainText("原文 • ▸ ✓ ⚙");
  const settings = page.getByRole("button", { name: "空间设置", exact: true });
  await expectIcon(settings, "settings");
  const folder = page.getByRole("row", { name: /图标样本/ });
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expectIcon(folder, "chevron-down");
  await folder.focus();
  await folder.press("ArrowLeft");
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expectIcon(folder, "chevron-right");
  await folder.press("ArrowRight");
  await expectIcon(page.getByRole("row", { name: "符号", exact: true }), "file-text");
  await expectIcon(page.getByRole("button", { name: "文档更多" }), "ellipsis");
  await openDocumentTool(page, "AI");
  const ai = page.getByRole("tab", { name: "AI", exact: true });
  await expect(ai).toHaveAttribute("aria-selected", "true");
  await expectIcon(page.getByRole("button", { name: "收起文档辅助区" }), "panel-right-close");
  const search = page.getByRole("button", { name: "搜索文档" });
  await search.press("Enter");
  const dialog = page.getByRole("dialog", { name: "快速打开与全文搜索" });
  await expectIcon(dialog, "search");
  await expect(dialog.getByRole("searchbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
});

test("selection marks in settings and menus reflect the accessible control state", async ({
  page,
}) => {
  await createNote(page, "设置图标.md", "# 设置");
  const switcher = page.getByRole("button", { name: /切换空间，当前为/ });
  await switcher.click();
  await expectIcon(page.getByRole("menuitemradio", { checked: true }), "check");
  await page.keyboard.press("Escape");

  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const preferences = page.getByRole("dialog", { name: "应用设置" });
  await expectIcon(preferences.getByRole("button", { name: /主题/ }), "chevron-down");
  const eink = preferences.getByRole("checkbox", { name: "墨水屏" });
  const label = preferences.locator("label").filter({ hasText: "墨水屏" });
  if (await eink.isChecked()) await eink.press("Space");
  await eink.press("Space");
  await expect(eink).toBeChecked();
  await expectIcon(label, "check");
  await eink.press("Space");
  await expect(eink).not.toBeChecked();
  await expect(label.locator('[data-icon="check"]')).toHaveCount(0);
});

test.describe("touch icons", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("the toolbar keeps a 44 px target around its glyph", async ({ page }) => {
    await createNote(page, "触摸图标.md", "# 图标");
    const more = page.getByRole("button", { name: "文档更多" });
    await expectIcon(more, "ellipsis");
    const target = await more.boundingBox();
    expect(target?.width).toBeGreaterThanOrEqual(44);
    expect(target?.height).toBeGreaterThanOrEqual(44);
    await more.tap();
    await expect(page.getByRole("menuitem", { name: "文档目录" })).toBeVisible();
  });
});
