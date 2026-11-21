import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { createNote } from "./productFixture";
import type { DocumentSnapshot } from "../../src/api/client";

async function measure(root: Locator, words: string[], firstPreview = false) {
  return root.evaluate(
    async (root, { words, firstPreview }) => {
      let content: Element = root;
      if (firstPreview) {
        content = await new Promise<HTMLElement>((resolve) => {
          const observe = () => {
            const editor = root.querySelector<HTMLElement>(
              '[role="textbox"][aria-label="Markdown 正文"]',
            );
            if (!editor) return;
            observer.disconnect();
            requestAnimationFrame(() => resolve(editor));
          };
          const observer = new MutationObserver(observe);
          observer.observe(root, { childList: true, subtree: true });
          observe();
        });
      }
      return words.map((word) => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode as Text;
          const at = text.data.indexOf(word);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          const rect = range.getBoundingClientRect();
          const css = getComputedStyle(text.parentElement!);
          return {
            x: rect.x,
            y: rect.y,
            size: css.fontSize,
            weight: css.fontWeight,
            lineHeight: css.lineHeight,
            color: css.color,
          };
        }
        throw new Error("Missing glyph " + word);
      });
    },
    { words, firstPreview },
  );
}

for (const heading of [false, true]) {
  test(`first-screen preview matches reading glyphs and paragraph spacing (${heading ? "heading" : "paragraph"} first)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const lead = "岸边的木桩留着一道水痕。";
    const second = "第二段从石桥开始记录。";
    const title = "潮汐记录";
    const section = "沿岸调查";
    const markdown =
      "\r\n\r\n" +
      (heading ? "# " + title + "\r\n\r\n" : "") +
      lead +
      "\r\n\r\n" +
      second +
      "\r\n\r\n## " +
      section +
      "\r\n\r\n桥头留影。";
    const { apiUrl } = await createNote(page, "首帧排版-" + heading + ".md", markdown);
    const words = [...(heading ? [title] : []), lead, second, section, "桥头留影"];
    const reading = page.getByRole("article");
    const before = await measure(reading, words);
    const point = before[words.indexOf(second)]!;
    const firstFrame = measure(page.locator("[data-reading-measure]"), words, true);
    await page.mouse.click(point.x + 2, point.y + 8);
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    const after = await firstFrame;
    await test.info().attach("reading-and-preview", {
      body: JSON.stringify({ words, before, after }, null, 2),
      contentType: "application/json",
    });
    for (const [i, old] of before.entries()) {
      const now = after[i]!;
      expect.soft(Math.abs(now.y - old.y), words[i] + " vertical shift").toBeLessThanOrEqual(1);
      expect.soft(Math.abs(now.x - old.x), words[i] + " horizontal shift").toBeLessThanOrEqual(1);
      expect.soft(now.size, words[i]).toBe(old.size);
      expect.soft(now.weight, words[i]).toBe(old.weight);
      expect.soft(now.color, words[i]).toBe(old.color);
    }
    await editor.press("Control+Home");
    await page.keyboard.insertText("开头");
    const saved = async () =>
      ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown;
    await expect.poll(saved).toBe("开头" + markdown);
    await editor.press("Control+z");
    await expect.poll(saved).toBe(markdown);
  });
}

test("a Setext title after YAML and a wrapped lead retain reading positions", async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 900 });
  const title = "河岸手记";
  const lead = "这段导语跨越几行，沿途的观测仍保存在原文中。".repeat(3) + "导语末尾。";
  const markdown =
    "---\ntitle: 河岸\n---\n\n\n**" +
    title +
    "**\n========\n\n" +
    lead +
    "\n\n\n下一段。\n## 水位\n有新的记录。";
  const { apiUrl } = await createNote(page, "河岸长导语.md", markdown);
  const words = [title, "导语末尾", "下一段", "水位", "有新的记录"];
  const reading = page.getByRole("article");
  const before = await measure(reading, words);
  const click = before[2]!;
  await page.mouse.click(click.x + 2, click.y + 8);
  const after = await measure(page.getByRole("textbox", { name: "Markdown 正文" }), words);
  for (const [i, old] of before.entries()) {
    expect.soft(Math.abs(after[i]!.x - old.x), words[i]).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(after[i]!.y - old.y), words[i]).toBeLessThanOrEqual(1);
  }
  // Compose on the empty source line immediately before the second paragraph.
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Home");
  await editor.press("ArrowLeft");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "补", selectionStart: 1, selectionEnd: 1 });
  const visiblePreedit = await editor.evaluate((editor) => {
    const line = editor.querySelector("[data-preview-caret]");
    if (!line || !line.textContent?.includes("补")) return false;
    return line.getBoundingClientRect().height >= parseFloat(getComputedStyle(line).fontSize);
  });
  expect(visiblePreedit).toBe(true);
  await ime.send("Input.insertText", { text: "补记" });
  const saved = async () =>
    ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown;
  await expect.poll(saved).toBe(markdown.replace("\n下一段", "补记\n下一段"));
  await editor.press("Control+z");
  await expect.poll(saved).toBe(markdown);
});
