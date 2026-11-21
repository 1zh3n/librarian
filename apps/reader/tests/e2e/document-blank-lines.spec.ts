import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createNote } from "./productFixture";
import type { DocumentSnapshot } from "../../src/api/client";

for (const count of [1, 3]) {
  test(`each of ${count} saved blank lines has a stable height and its own insertion point`, async ({
    page,
  }) => {
    const source = "啊" + "\r\n".repeat(count + 1) + "啊";
    const { apiUrl } = await createNote(page, `原样空行-${count}.md`, source);
    const article = page.getByRole("article");
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    const saved = async () =>
      ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown;
    for (let i = 0; i < count; i++) {
      await expect(article.getByText("啊", { exact: true })).toHaveCount(2);
      const points = await article.evaluate((el) => {
        const [upper, lower] = el.querySelectorAll("p");
        const glyph = (node: Element) => {
          const r = new Range();
          r.selectNodeContents(node);
          return r.getBoundingClientRect().y;
        };
        return {
          top: upper!.getBoundingClientRect().bottom,
          bottom: lower!.getBoundingClientRect().top,
          x: upper!.getBoundingClientRect().left + 4,
          lh: parseFloat(getComputedStyle(el).lineHeight),
          before: [glyph(upper!), glyph(lower!)],
        };
      });
      expect(Math.abs(points.bottom - points.top - count * points.lh)).toBeLessThan(1);
      const samples = await page.getByRole("main").evaluateHandle((main) => ({
        frames: new Promise<number[][]>((done) => {
          main.addEventListener(
            "pointerdown",
            () => {
              const frames: number[][] = [];
              function sample() {
                const root = main.querySelector('[aria-label="Markdown 正文"], article')!;
                const tree = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                const pair: number[] = [];
                while (tree.nextNode()) {
                  if (tree.currentNode.textContent !== "啊") continue;
                  const r = new Range();
                  r.selectNodeContents(tree.currentNode);
                  pair.push(r.getBoundingClientRect().y);
                }
                frames.push(pair);
                if (frames.length < 24) requestAnimationFrame(sample);
                else done(frames);
              }
              requestAnimationFrame(sample);
            },
            { capture: true, once: true },
          );
        }),
      }));
      if (count === 3 && i === 1)
        await page.screenshot({ path: test.info().outputPath("blank-reading.png") });
      await page.mouse.click(points.x, points.top + (i + 0.5) * points.lh);
      await expect(editor).toBeFocused();
      if (count === 3 && i === 1)
        await page.screenshot({
          path: test.info().outputPath("blank-editing.png"),
          caret: "initial",
        });
      const frames = await samples.evaluate((s) => s.frames);
      for (const pair of frames) {
        expect(pair).toHaveLength(2);
        for (const [j, y] of pair.entries())
          expect(Math.abs(y - points.before[j]!)).toBeLessThan(1);
      }
      await page.keyboard.insertText("中");
      const offset = 1 + (i + 1) * 2;
      await expect.poll(saved).toBe(source.slice(0, offset) + "中" + source.slice(offset));
      await editor.press("Control+z");
      await expect.poll(saved).toBe(source);
      await editor.press("Escape");
    }
  });
}

test("Enter keeps each written line in reading after save and reload", async ({ page }) => {
  const { apiUrl } = await createNote(page, "敲回车.md", "啊");
  await page.getByRole("article").getByText("啊").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("End");
  for (let i = 0; i < 4; i++) await editor.press("Enter");
  await page.keyboard.insertText("乙");
  await editor.press("Enter");
  await page.keyboard.insertText("丙");
  const expected = "啊\n\n\n\n乙\n丙";
  await editor.press("Control+s");
  await expect
    .poll(
      async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
    )
    .toBe(expected);
  async function positions(root: Locator) {
    return root.evaluate((el) => {
      const ys: number[] = [];
      for (const ch of ["啊", "乙", "丙"]) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode,
            index = node.textContent?.indexOf(ch) ?? -1;
          if (index < 0) continue;
          const r = new Range();
          r.setStart(node, index);
          r.setEnd(node, index + 1);
          ys.push(r.getBoundingClientRect().top);
          break;
        }
      }
      return ys;
    });
  }
  const written = await positions(editor);
  expect(written).toHaveLength(3);
  expect(written[2]! - written[1]!).toBeGreaterThan(16);
  await editor.press("Escape");
  const article = page.getByRole("article");
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(article).toBeVisible();
    const visible = await positions(article);
    expect(visible).toHaveLength(3);
    for (const [i, y] of visible.entries()) expect(Math.abs(y - written[i]!)).toBeLessThan(1);
  }
});

test("explicit Markdown breaks and soft breaks each occupy one line", async ({ page }) => {
  await createNote(page, "段内换行.md", "甲  \n乙\\\n丙\n丁");
  const rows = await page
    .getByRole("article")
    .locator("p")
    .evaluate((el) => {
      const height = parseFloat(getComputedStyle(el).lineHeight);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT),
        tops: number[] = [];
      while (walker.nextNode()) {
        const n = walker.currentNode;
        for (const match of n.textContent!.matchAll(/[甲乙丙丁]/g)) {
          const r = new Range();
          r.setStart(n, match.index);
          r.setEnd(n, match.index + 1);
          tops.push(r.getBoundingClientRect().top);
        }
      }
      return { height, tops };
    });
  expect(rows.tops).toHaveLength(4);
  for (let i = 1; i < 4; i++)
    expect(Math.abs(rows.tops[i]! - rows.tops[i - 1]! - rows.height)).toBeLessThan(1);
});
