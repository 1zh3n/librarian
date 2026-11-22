import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import type { Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

async function checkIcon(button: Locator, touch: boolean) {
  const icon = button.locator("[data-icon] svg");
  await expect(icon).toBeVisible();
  const [target, glyph] = await Promise.all([button.boundingBox(), icon.boundingBox()]);
  if (!target || !glyph) throw new Error("The control and glyph must be visible");
  expect.soft(target.width).toBeGreaterThanOrEqual(touch ? 44 : 24);
  expect.soft(target.height).toBeGreaterThanOrEqual(touch ? 44 : 24);
  expect
    .soft(Math.abs(target.x + target.width / 2 - glyph.x - glyph.width / 2))
    .toBeLessThanOrEqual(1);
  expect
    .soft(Math.abs(target.y + target.height / 2 - glyph.y - glyph.height / 2))
    .toBeLessThanOrEqual(1);
}

async function checkTextButton(button: Locator, touch: boolean) {
  await expect(button).toBeVisible();
  const style = await button.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      padding: [
        css.paddingInlineStart,
        css.paddingInlineEnd,
        css.paddingBlockStart,
        css.paddingBlockEnd,
      ].map(parseFloat),
      height: el.getBoundingClientRect().height,
      font: css.fontSize,
    };
  });
  expect.soft(style.padding[0]).toBeGreaterThanOrEqual(16);
  expect.soft(style.padding[2]).toBeGreaterThanOrEqual(8);
  expect.soft(style.padding[0]).toBe(style.padding[1]);
  expect.soft(style.padding[2]).toBe(style.padding[3]);
  expect.soft(style.height).toBeGreaterThanOrEqual(touch ? 44 : 36);
  return style;
}

for (const touch of [false, true]) {
  test.describe(touch ? "phone controls" : "desktop controls", () => {
    test.use({
      hasTouch: touch,
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    });
    test("centers directory glyphs and uses consistent save and dialog actions", async ({
      page,
    }) => {
      await openFieldWorkspace(page);
      const headers = { origin: new URL(page.url()).origin };
      const response = await page.request.post("/api/v1/workspaces", {
        headers,
        data: { name: "河岸记录" },
      });
      expect(response.status()).toBe(201);
      const workspace = (await response.json()) as Workspace;
      const notes = `/api/v1/workspaces/${workspace.id}/documents`;
      const note = await page.request.post(notes, {
        headers,
        data: { path: "河岸/走访.md", markdown: "河边的记录", baseRevision: null },
      });
      expect(note.status()).toBe(201);
      await page.goto(`/workspaces/${workspace.id}/documents/${(await note.json()).document.id}`);
      await expect(page.getByRole("article")).toContainText("河边的记录");
      if (touch) await page.getByRole("button", { name: "展开目录" }).tap();
      const folder = page.getByRole("row", { name: "河岸", exact: true });
      const chevron = folder
        .getByRole("button")
        .filter({ has: page.locator('[data-icon^="chevron-"]') });
      const gear = page.getByRole("button", { name: "空间设置", exact: true });
      await checkIcon(gear, touch);
      await checkIcon(chevron, touch);
      await folder.press("ArrowLeft");
      await expect(folder).toHaveAttribute("aria-expanded", "false");
      await checkIcon(chevron, touch);
      await folder.press("ArrowRight");
      const more = folder.getByRole("button", { name: "河岸更多" });
      if (touch) await more.tap();
      else await folder.press("Shift+F10");
      await expect(folder).toHaveAttribute("data-command-target", "true");
      await checkIcon(chevron, touch);
      await page.getByRole("menuitem", { name: "新建文档…" }).click();
      const dialog = page.getByRole("dialog", { name: "新建文档" });
      const create = dialog.getByRole("button", { name: "创建文档" });
      await expect(create).toBeDisabled();
      await dialog.getByRole("textbox", { name: "文档名称" }).fill("水位");
      await expect(create).toBeEnabled();
      const primary = await checkTextButton(create, touch);
      const cancel = dialog.getByRole("button", { name: "取消" });
      expect.soft(await checkTextButton(cancel, touch)).toEqual(primary);
      await cancel.click();
      await expect(dialog).toBeHidden();
      await gear.click();
      const form = page.getByRole("form", { name: "空间设置" });
      const save = form.getByRole("button", { name: "保存空间设置" });
      expect.soft(await checkTextButton(save, touch)).toEqual(primary);
      await form.getByRole("textbox", { name: "空间名称" }).fill("河岸走访");
      await save.click();
      await expect(form).toContainText("空间设置已保存");
    });
  });
}

test.describe("narrow enlarged controls", () => {
  test.use({ viewport: { width: 320, height: 760 }, hasTouch: true });
  test("keeps the document fields and entire create label inside the dialog at 200% text", async ({
    page,
  }) => {
    const space = await openFieldWorkspace(page);
    await page.goto(`/workspaces/${space.id}`);
    await page.addStyleTag({ content: "html { font-size: 200% }" });
    await page.getByRole("button", { name: "展开目录" }).tap();
    await page.getByRole("button", { name: "根目录更多" }).tap();
    await page.getByRole("menuitem", { name: "新建文档…" }).tap();
    const dialog = page.getByRole("dialog", { name: "新建文档" });
    const field = dialog.getByRole("textbox", { name: "文档名称" });
    await field.fill("水位记录");
    const form = dialog.locator("form");
    const bounds = await form.boundingBox();
    if (!bounds) throw new Error("Expected the create form on screen");
    for (const input of await form.getByRole("textbox").all()) {
      const box = await input.boundingBox();
      if (!box) throw new Error("Expected a visible field");
      expect.soft(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    }
    const create = dialog.getByRole("button", { name: "创建文档" });
    expect
      .soft(
        await create.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        }),
      )
      .toBe(1);
    await create.tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  });
});
