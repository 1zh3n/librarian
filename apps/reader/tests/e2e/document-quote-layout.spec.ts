import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

function glyphs(root: Locator, words: string[]) {
  return root.evaluate(
    (root, words) =>
      words.map((word) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const idx = node.textContent?.indexOf(word) ?? -1;
          if (idx < 0) continue;
          const range = new Range();
          range.setStart(node, idx);
          range.setEnd(node, idx + 1);
          const { x, y, width, height } = range.getBoundingClientRect();
          return { x, y, width, height };
        }
        throw new Error("Missing glyph: " + word);
      }),
    words,
  );
}

for (const emptyLines of [1, 3]) {
  test(`stored quote with ${emptyLines} empty rows keeps the following paragraph and accepts a click on its last row`, async ({
    page,
  }, info) => {
    const run = Array.from({ length: emptyLines }, (_, i) =>
      i === emptyLines - 1 ? "> " : ">",
    ).join("\r\n");
    const source = "上段\r\n" + run + "\r\n下段";
    const { apiUrl } = await createNote(
      page,
      `空引用-${emptyLines}-${info.repeatEachIndex}.md`,
      source,
    );
    const article = page.getByRole("article");
    const quote = article.locator("blockquote");
    await expect(quote).toBeAttached();
    const before = await glyphs(article, ["上", "下"]);
    const row = await quote.evaluate((q) => {
      const r = q.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(q).lineHeight);
      return { height: r.height, line, x: r.left + 12, y: r.top + line / 2 };
    });
    expect
      .soft(
        Math.abs(row.height - row.line * emptyLines),
        "one writable row per stored quote marker",
      )
      .toBeLessThanOrEqual(1);
    const point = { x: row.x, y: row.y + (emptyLines - 1) * row.line };
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await page.mouse.click(point.x, point.y);
    await expect(editor).toBeFocused();
    const during = await glyphs(editor, ["上", "下"]);
    await editor.press("Escape");
    const returned = await glyphs(article, ["上", "下"]);
    await info.attach("quote-layout.json", {
      body: JSON.stringify({ before, during, returned, row, point }),
      contentType: "application/json",
    });
    for (const state of [during, returned])
      expect
        .soft(Math.abs(state[1]!.y - before[1]!.y), "following paragraph y")
        .toBeLessThanOrEqual(1);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.insertText("引");
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe(source.replace("> \r\n下", "> 引\r\n下"));
  });
}

for (const width of [1440, 320]) {
  test(`multi-paragraph and nested quotes keep wrapped text and its Markdown insertion point at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const source = (
      "上段\n\n> 甲段\n>\n> 乙段\n> > 丙段\n> > " +
      "河岸潮声".repeat(8) +
      "鹭\n>\n> 丁段\n\n下段"
    ).replaceAll("\n", width === 320 ? "\r\n" : "\n");
    const { apiUrl } = await createNote(
      page,
      `嵌套引用-${width}-${info.repeatEachIndex}.md`,
      source,
    );
    const article = page.getByRole("article");
    const words = ["甲", "乙", "丙", "鹭", "丁", "下"];
    const before = await glyphs(article, words);
    const glyph = before[3]!;
    const point = { x: glyph.x + glyph.width / 4, y: glyph.y + glyph.height / 2 };
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await page.mouse.click(point.x, point.y);
    await expect(editor).toBeFocused();
    const during = await glyphs(editor, words);
    await editor.press("Escape");
    const returned = await glyphs(article, words);
    await info.attach("quote-layout.json", {
      body: JSON.stringify({ words, before, during, returned, point }),
      contentType: "application/json",
    });
    for (const state of [during, returned])
      for (const [i, old] of before.entries())
        for (const axis of ["x", "y"] as const)
          expect
            .soft(Math.abs(old[axis] - state[i]![axis]), words[i] + " " + axis)
            .toBeLessThanOrEqual(1);
    await page.mouse.click(point.x, point.y);
    await page.keyboard.insertText("新");
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe(source.replace("鹭", "新鹭"));
  });
}

test("an empty row inside a nested quote accepts input after both stored markers", async ({
  page,
}, info) => {
  const source = "上段\n\n> > 前句\n> > \n> > 后句\n\n下段";
  const { apiUrl } = await createNote(page, `内部空引用-${info.repeatEachIndex}.md`, source);
  const article = page.getByRole("article");
  const before = await glyphs(article, ["前", "后", "下"]);
  const first = before[0]!,
    next = before[1]!;
  const x = first.x + 2,
    y = (first.y + first.height + next.y) / 2;
  await page.mouse.click(x, y);
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  const during = await glyphs(editor, ["前", "后", "下"]);
  for (const [i, glyph] of before.entries())
    expect.soft(Math.abs(during[i]!.y - glyph.y)).toBeLessThanOrEqual(1);
  await editor.press("Escape");
  await page.mouse.click(x, y);
  await page.keyboard.insertText("填");
  await expect
    .poll(
      async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
    )
    .toBe(source.replace("> > \n", "> > 填\n"));
});
