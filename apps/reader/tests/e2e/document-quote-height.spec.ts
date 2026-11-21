import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createNote } from "./productFixture";
import type { DevicePreferences, DocumentSnapshot } from "../../src/api/client";

async function textRows(page: Page) {
  return page.locator("[data-reading-measure]").evaluate((canvas) => {
    const root = canvas.querySelector("article, [aria-label='Markdown 正文']")!;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const rows: Record<string, number> = {};
    while (walk.nextNode()) {
      const text = walk.currentNode as Text;
      for (const match of text.data.matchAll(/[甲乙引]/g)) {
        const range = new Range();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + 1);
        const rect = range.getBoundingClientRect();
        if (rect.height) rows[match[0]] = rect.y;
      }
    }
    return rows;
  });
}

for (const { width, leading } of [
  { width: 1440, leading: 1.85 },
  { width: 390, leading: 1.85 },
  { width: 1024, leading: 1.4 },
]) {
  test(`writing a quote on the line between two paragraphs grows only for an actual Enter at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const original = "上段甲。\r\n\r\n下段乙。";
    const { apiUrl, origin } = await createNote(page, `段间引用-${width}.md`, original);
    const article = page.getByRole("article");
    if (leading !== 1.85) {
      await article.waitFor();
      const device = await page.evaluate(() => localStorage.getItem("librarian.device"));
      const endpoint = `/api/v1/settings/devices/${device}`;
      const defaults = (await (await page.request.get(endpoint)).json()) as DevicePreferences;
      expect(
        (
          await page.request.put(endpoint, {
            headers: { origin },
            data: { ...defaults, lineHeight: leading },
          })
        ).ok(),
      ).toBe(true);
      await page.reload();
      await expect(article).toHaveCSS(
        "line-height",
        `${(defaults.fontSize * leading).toFixed(1)}px`,
      );
    }
    const lineHeight = await article.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const before = await textRows(page);
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    const steps: { stage: string; top: number; bottom: number }[] = [];
    async function check(stage: string, addedLines = 0) {
      const now = await textRows(page);
      steps.push({ stage, top: now["甲"]!, bottom: now["乙"]! });
      expect.soft(Math.abs(now["甲"]! - before["甲"]!), stage + " upper glyph").toBeLessThan(1);
      expect
        .soft(
          Math.abs(now["乙"]! - before["乙"]! - addedLines * lineHeight),
          stage + " lower glyph",
        )
        .toBeLessThan(1);
    }
    await article.locator("[data-blank-line]").click();
    await expect(editor).toBeFocused();
    await check("click blank line");
    await page.keyboard.type(">");
    await check("type marker");
    await page.keyboard.type(" ");
    await check("add space");
    await editor.press("Escape");
    await check("read empty quote");
    // Use the keyboard to return to the same insertion point.
    await article.press("Alt+e");
    await expect(editor).toBeFocused();
    await check("reopen empty quote");
    await page.keyboard.insertText("引文");
    await check("write quote");
    await editor.press("Enter");
    await check("continue on new line", 1);
    await editor.press("Enter");
    await check("exit quote on that line", 1);
    await editor.press("Escape");
    await check("return to reading", 1);
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe("上段甲。\r\n> 引文\n\r\n下段乙。");
    await info.attach("quote-heights", {
      body: JSON.stringify({ lineHeight, before, steps }, null, 2),
      contentType: "application/json",
    });
  });
}
