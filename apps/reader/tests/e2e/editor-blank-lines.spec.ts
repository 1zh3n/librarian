import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openDocument(page: Page, source: string, offset: number, leading = 1.85) {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/spike");
  const session = await page.evaluateHandle(
    async ({ source, offset, leading }) => {
      const path = "/src/editor/codemirror/adapter.ts";
      const { openEditor }: typeof import("../../src/editor/codemirror/adapter") = await import(
        /* @vite-ignore */ path
      );
      const editor = openEditor(source, {
        documentTypography: true,
        hideMetadataInPreview: true,
        selection: { anchor: offset, head: offset },
      });
      const host = document.body.appendChild(document.createElement("div"));
      host.style.cssText =
        "position:fixed;inset:0;background:white;font-size:18px;--reading-size:18px";
      host.style.setProperty("--reading-line-height", String(leading));
      editor.mount(host);
      return editor;
    },
    { source, offset, leading },
  );
  const input = page.getByRole("textbox", { name: "Markdown 正文" });
  const layout = () =>
    input.evaluate((content) => {
      const lines = Array.from(content.querySelectorAll(".cm-line"), (line) => {
        const rect = line.getBoundingClientRect();
        return { text: line.textContent, top: rect.top, height: rect.height };
      });
      return {
        lines,
        lineHeight: parseFloat(getComputedStyle(content).lineHeight),
        bottomPadding: parseFloat(getComputedStyle(content).paddingBottom),
      };
    });
  return { session, input, layout };
}

for (const leading of [1.85, 1.35]) {
  test(`blank source lines keep their height around paragraphs and headings at leading ${leading}`, async ({
    page,
  }) => {
    const source =
      "---\r\ntitle: 原文\r\n---\r\n\r\n\r\n导语\r\n \r\n\r\n正文\r\n\r\n\r\n## 标题\r\n段落";
    const { input, session, layout } = await openDocument(
      page,
      source,
      source.indexOf("正文"),
      leading,
    );
    const before = await layout();
    const { lines, lineHeight } = before;
    expect(lines.map((line) => line.text)).toEqual([
      "",
      "",
      "导语",
      " ",
      "",
      "正文",
      "",
      "",
      "## 标题",
      "段落",
    ]);
    const leadMargin = 18 * 1.075 * 1.45;
    const headingMargin = 18 * 1.45 * 1.7;
    for (const [i, height] of [
      [0, lineHeight],
      [1, lineHeight],
      [3, Math.max(lineHeight, leadMargin)],
      [4, lineHeight],
      [6, Math.max(lineHeight, headingMargin)],
      [7, lineHeight],
    ] as const)
      expect(lines[i]!.height).toBeCloseTo(height, 1);
    const left = (await input.boundingBox())!.x;
    const heading = source.indexOf("##");
    for (const [index, offset] of [
      [6, heading - 4],
      [7, heading - 2],
    ] as const) {
      const line = lines[index]!;
      await page.mouse.click(left + 4, line.top + line.height / 2);
      expect(await session.evaluate((e) => e.selection().head)).toBe(offset);
      expect(await layout()).toEqual(before);
    }
    expect(await session.evaluate((e) => e.source())).toBe(source);
  });
}

test("twelve manual Enters keep distinct editable rows through caret moves and repeated paper clicks", async ({
  page,
}) => {
  const original = "导语\n\n正文";
  const { session, input, layout } = await openDocument(page, original, original.length);
  for (let i = 0; i < 12; i++) await input.press("Enter");
  const expected = original + "\n".repeat(12);
  expect(await session.evaluate((e) => e.source())).toBe(expected);
  const atEnd = await layout();
  expect(atEnd.lines.slice(3)).toHaveLength(12);
  for (const line of atEnd.lines.slice(3)) expect(line.height).toBeCloseTo(atEnd.lineHeight, 1);
  expect(atEnd.bottomPadding).toBe(4 + 18);
  await expect(input.getByText("正文", { exact: true })).toBeInViewport();
  const last = atEnd.lines.at(-1)!;
  expect(last.top + last.height).toBeLessThanOrEqual(900);
  for (let i = 1; i <= 12; i++) {
    await input.press("ArrowUp");
    expect(await session.evaluate((e) => e.selection().head)).toBe(
      i === 12 ? original.indexOf("正文") : expected.length - i,
    );
    expect(await layout()).toEqual(atEnd);
  }
  for (let i = 0; i < 2; i++) {
    await session.evaluate((e) => e.placeCaretAtPaperPoint(100, 860));
    expect(await session.evaluate((e) => e.selection().head)).toBe(expected.length);
    expect(await layout()).toEqual(atEnd);
  }
  await page.keyboard.insertText("续");
  expect(await session.evaluate((e) => e.source())).toBe(expected + "续");
  await input.press("Control+z");
  expect(await session.evaluate((e) => e.source())).toBe(expected);
});

test("existing whitespace-only rows stay individually clickable and writable", async ({ page }) => {
  const source = "\r\n".repeat(12) + "  ";
  const { input, layout, session } = await openDocument(page, source, 0);
  const initial = await layout();
  expect(initial.lines).toHaveLength(13);
  for (const line of initial.lines) expect(line.height).toBeCloseTo(initial.lineHeight, 1);
  const fifth = initial.lines[4]!;
  const left = (await input.boundingBox())!.x;
  await page.mouse.click(left + 4, fifth.top + fifth.height / 2);
  expect(await session.evaluate((e) => e.selection().head)).toBe(8);
  expect(await layout()).toEqual(initial);
  await page.keyboard.insertText("写");
  expect(await session.evaluate((e) => e.source())).toBe(
    source.slice(0, 8) + "写" + source.slice(8),
  );
  await input.press("Control+z");
  expect(await session.evaluate((e) => e.source())).toBe(source);
  await session.evaluate((e) => e.placeCaretAtPaperPoint(100, 860));
  expect(await session.evaluate((e) => e.selection().head)).toBe(source.length);
  expect(await layout()).toEqual(initial);
});
