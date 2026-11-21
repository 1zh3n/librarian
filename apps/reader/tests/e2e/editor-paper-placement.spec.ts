import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openPaper(page: Page, markdown: string, sourceMode = false) {
  await page.goto("/spike");
  return page.evaluateHandle(
    async ({ markdown, sourceMode }) => {
      const path = "/src/editor/codemirror/adapter.ts";
      const { openEditor }: typeof import("../../src/editor/codemirror/adapter") = await import(
        /* @vite-ignore */ path
      );
      const session = openEditor(markdown, {
        hideMetadataInPreview: true,
        selection: { anchor: markdown.length, head: markdown.length },
      });
      session.setSourceMode(sourceMode);
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;top:80px;left:100px;width:230px;background:white";
      document.body.appendChild(host);
      session.mount(host, false);
      return session;
    },
    { markdown, sourceMode },
  );
}

for (const mode of ["preview", "source"] as const) {
  test(`paper coordinates follow wrapped rows, empty lines and the first writable line in ${mode}`, async ({
    page,
  }) => {
    const metadata = "---\r\ntitle: 纸面\r\n---\r\n";
    const paragraph = "从第一行开始寻找每一个可写位置。".repeat(5);
    const source = metadata + paragraph + "\r\n\r\n末行";
    const session = await openPaper(page, source, mode === "source");
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    const points = await editor.getByText(paragraph, { exact: true }).evaluate((line) => {
      const text = line.firstChild;
      if (!(text instanceof Text)) throw new Error("Missing paragraph text");
      const range = document.createRange();
      const rows: { first: number; end: number; y: number }[] = [];
      for (let i = 0; i < text.length; i++) {
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const rect = range.getBoundingClientRect();
        const y = (rect.top + rect.bottom) / 2;
        if (rows.at(-1)?.y !== y) rows.push({ first: i, end: i, y });
        rows.at(-1)!.end = i + 1;
      }
      const first = rows[0],
        second = rows[1];
      if (!first || !second) throw new Error("Paragraph must wrap");
      const box = line.getBoundingClientRect();
      const empty = line.nextElementSibling!.getBoundingClientRect();
      return {
        first,
        second,
        left: box.left - 20,
        right: box.right + 20,
        above: line.closest('[role="textbox"]')!.getBoundingClientRect().top - 20,
        empty: (empty.top + empty.bottom) / 2,
      };
    });
    for (const [x, y, offset] of [
      [points.right, points.first.y, metadata.length + points.first.end],
      [points.left, points.second.y, metadata.length + points.second.first],
      [points.right, points.second.y, metadata.length + points.second.end],
      [points.left, points.empty, metadata.length + paragraph.length + 2],
      [points.left, points.above, mode === "preview" ? metadata.length : 0],
    ] as const) {
      await session.evaluate((editor, point) => editor.placeCaretAtPaperPoint(point.x, point.y), {
        x,
        y,
      });
      await expect(editor).toBeFocused();
      expect(await session.evaluate((editor) => editor.selection())).toEqual({
        anchor: offset,
        head: offset,
      });
      expect(await session.evaluate((editor) => editor.source())).toBe(source);
    }
    await page.keyboard.insertText("写");
    const start = mode === "preview" ? metadata.length : 0;
    expect(await session.evaluate((editor) => editor.source())).toBe(
      source.slice(0, start) + "写" + source.slice(start),
    );
  });
}

test("two below-paper clicks reuse the final blank line and retain undo", async ({ page }) => {
  for (const original of ["", "甲\r\n乙", "尾\n\n", "尾\n  "]) {
    const session = await openPaper(page, original);
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    for (let i = 0; i < 2; i++) {
      await session.evaluate((editor) => editor.placeCaretAtPaperPoint(120, 650));
    }
    const ready = original === "甲\r\n乙" ? original + "\r\n" : original;
    expect(await session.evaluate((editor) => editor.source())).toBe(ready);
    await expect(editor).toBeFocused();
    await page.keyboard.insertText("续");
    expect(await session.evaluate((editor) => editor.source())).toBe(ready + "续");
    await editor.press("Control+z");
    if (ready !== original) await editor.press("Control+z");
    expect(await session.evaluate((editor) => editor.source())).toBe(original);
  }
});

test("clicking above a metadata-only preview leaves the YAML intact", async ({ page }) => {
  const yaml = "---\r\ntitle: 保留\r\n---";
  const session = await openPaper(page, yaml);
  await session.evaluate((editor) => editor.placeCaretAtPaperPoint(80, 40));
  await page.keyboard.insertText("正文");
  expect(await session.evaluate((editor) => editor.source())).toBe(yaml + "\r\n正文");
});

test("paper positioning leaves an active IME composition and selection alone", async ({ page }) => {
  const session = await openPaper(page, "甲乙丙");
  const input = page.getByRole("textbox", { name: "Markdown 正文" });
  await session.evaluate((editor) => {
    editor.select({ anchor: 1, head: 2 });
    editor.focus();
  });
  await input.dispatchEvent("compositionstart");
  await session.evaluate((editor) => editor.placeCaretAtPaperPoint(120, 650));
  expect(await session.evaluate((editor) => editor.selection())).toEqual({ anchor: 1, head: 2 });
  expect(await session.evaluate((editor) => editor.source())).toBe("甲乙丙");
});
