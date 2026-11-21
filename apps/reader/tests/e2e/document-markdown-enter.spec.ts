import { expect, test } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

test("continues and exits Markdown items in place and saves the exact source", async ({ page }) => {
  const original = "**保留**\r\n\r\n> 引文";
  const { apiUrl } = await createNote(page, "引用列表续写.md", original);
  const article = page.getByRole("article");
  const point = await article.getByText("引文", { exact: true }).evaluate((paragraph) => {
    const text = paragraph.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing quote text");
    const glyph = document.createRange();
    glyph.setStart(text, 0);
    glyph.setEnd(text, 1);
    const rect = glyph.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor.locator("strong")).toHaveText("保留");
  await editor.press("Control+End");
  await editor.press("Enter");
  await page.keyboard.insertText("第二行");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.keyboard.insertText("1. [x] 首项");
  await editor.press("Enter");
  await page.keyboard.insertText("待办");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.keyboard.insertText("普通段落");
  await editor.press("Escape");
  await expect(article.getByRole("checkbox")).toHaveCount(2);
  const expected = original + "\n> 第二行\n1. [x] 首项\n2. [ ] 待办\n普通段落";
  await expect
    .poll(async () => {
      const snapshot = (await (await page.request.get(apiUrl)).json()) as DocumentSnapshot;
      return snapshot.markdown;
    })
    .toBe(expected);
});
