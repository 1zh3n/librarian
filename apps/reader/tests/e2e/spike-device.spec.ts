import { expect, test } from "@playwright/test";

test("local_undo_does_not_silently_revert_committed_ai", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/editor/codemirror/adapter.ts";
    const { openEditor } = await import(/* @vite-ignore */ modulePath);
    const session = openEditor("原文", { revision: "r1" });
    const parent = document.createElement("div");
    document.body.append(parent);
    session.mount(parent);
    const patch = {
      baseRevision: "r1",
      revision: "r2",
      edits: [{ from: 2, to: 2, insert: "修改" }],
    };
    return session.applyExternal(patch);
  });
  expect(result).toBe("applied");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("End");
  await page.keyboard.insertText("本地");
  await expect(editor).toHaveText("原文修改本地");
  await editor.press("Control+z");
  await expect(editor).toHaveText("原文修改");
  await editor.press("Control+z");
  await expect(editor).toHaveText("原文修改");
});

test("viewport_360_has_no_page_overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/?fixture=narrow");
  const viewport = page.locator("[data-scroll-surface]");
  const reading = page.getByRole("article");
  const table = reading.getByRole("table", { name: "" }).filter({ hasText: "海边" });
  const code = reading.locator("pre").filter({ hasText: "潮水退了。潮水退了。" });
  await expect(table).toBeVisible();
  await expect(code).toBeVisible();
  const hasOverflow = (element: Element) => element.scrollWidth > element.clientWidth;
  expect(await viewport.evaluate(hasOverflow)).toBe(false);
  const tableScroll = table.locator("..");
  expect(await tableScroll.evaluate(hasOverflow)).toBe(true);
  expect(await code.evaluate(hasOverflow)).toBe(true);
  await page.getByRole("button", { name: "编辑正文" }).click();
  expect(await viewport.evaluate(hasOverflow)).toBe(false);
});
