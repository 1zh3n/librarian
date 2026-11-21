import { expect, test } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

test.use({ viewport: { width: 1440, height: 900 } });

const targetWord = "木桩";
const marker = "【补记】";
type GlyphFrame = { ms: number; glyphY: number | null; scrollTop: number };
const paragraph =
  "我们沿着河岸走到石桥，观察清晨的水位和潮汐退去后的沙纹，把芦苇的颜色和新发现的脚印逐一写进笔记。";
const sections = Array.from({ length: 41 }, (_, index) => {
  const start = index === 20 ? "桥边的木桩留着一道水痕。" : "河边的石阶留着一道水痕。";
  return [`## 第${index + 1}站 · 河岸记录`, start + paragraph.repeat(2), paragraph].join("\n\n");
});

for (const { name, markdown, deep } of [
  {
    name: "leading blank lines at the top",
    markdown: "\n\n岸边的木桩留着一道水痕。\n\n" + paragraph,
    deep: false,
  },
  { name: "middle of a long document with headings", markdown: sections.join("\n\n"), deep: true },
]) {
  test(`first text click keeps the same glyph steady and editable (${name})`, async ({
    page,
  }, testInfo) => {
    const { apiUrl } = await createNote(
      page,
      `稳定落点-${deep ? "中段" : "页首"}-${testInfo.repeatEachIndex}-${testInfo.retry}.md`,
      markdown,
    );
    const article = page.getByRole("article");
    await expect(article.getByText(targetWord, { exact: false })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const main = page.getByRole("main");
    if (deep) {
      await article.getByRole("heading", { name: "第21站 · 河岸记录" }).evaluate((heading) => {
        heading.closest("main")!.scrollTop += heading.getBoundingClientRect().top - 215;
      });
      expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(900);
    } else {
      expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
    }

    const probe = await main.evaluateHandle((viewport, glyph) => {
      function locate() {
        let offscreen: DOMRect | null = null;
        for (const root of viewport.querySelectorAll(
          'article, [contenteditable="true"][aria-label="Markdown 正文"]',
        )) {
          if (!root.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const offset = text.textContent?.indexOf(glyph) ?? -1;
            if (offset < 0) continue;
            const range = new Range();
            range.setStart(text, offset);
            range.setEnd(text, offset + glyph.length);
            const rect = range.getBoundingClientRect();
            if (!rect.height || !rect.width) continue;
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            if (hit && root.contains(hit)) return rect;
            if (!hit) offscreen = rect;
          }
        }
        return offscreen;
      }
      const read = locate();
      if (!read) throw new Error("The target glyph is missing from the reading surface");
      const x = read.left + read.width / 4;
      const y = read.top + read.height / 2;
      if (!document.elementFromPoint(x, y)?.closest("article"))
        throw new Error("Target is outside the reading viewport");
      const frames = new Promise<GlyphFrame[]>((resolve) => {
        viewport.addEventListener(
          "pointerdown",
          () => {
            const samples: GlyphFrame[] = [];
            const start = performance.now();
            function sample() {
              const ms = performance.now() - start;
              samples.push({ ms, glyphY: locate()?.top ?? null, scrollTop: viewport.scrollTop });
              if (ms >= 400 && samples.length >= 24) resolve(samples);
              else requestAnimationFrame(sample);
            }
            requestAnimationFrame(sample);
          },
          { capture: true, once: true },
        );
      });
      return { x, y, readY: read.top, frames };
    }, "桩");

    const point = await probe.evaluate(({ x, y, readY }) => ({ x, y, readY }));
    await page.mouse.click(point.x, point.y);
    const frames = await probe.evaluate((probe) => probe.frames);
    await testInfo.attach("glyph-frames.json", {
      body: JSON.stringify({ point, frames }, null, 2),
      contentType: "application/json",
    });

    const editor = page.locator('[contenteditable="true"][aria-label="Markdown 正文"]');
    await expect(editor).toBeFocused();
    await page.keyboard.insertText(marker);
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe(markdown.replace(targetWord, "木" + marker + "桩"));

    // Allow integer scroll rounding while keeping the original glyph under the pointer.
    const unstable = frames.filter(
      ({ glyphY }) => glyphY === null || Math.abs(glyphY - point.readY) > 1,
    );
    expect(unstable, `Reading glyph y=${point.readY}; missing or displaced frames`).toEqual([]);
  });
}

test("a preview table keeps its reading height and the following paragraph in place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  const markdown =
    "开头。\n\n| 测点 | 水深 |\n| --- | --- |\n| 溪边 | 一米 |\n| 岸边 | 两米 |\n\n表后的段落。\n\n\n";
  const { apiUrl } = await createNote(page, "测点表.md", markdown);
  const geometry = async () =>
    page.locator("[data-reading-measure] table").evaluate((table) => {
      const rect = table.getBoundingClientRect();
      const root = table.closest("[data-reading-measure]")!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.startsWith("表后的段落")) continue;
        const range = new Range();
        range.selectNodeContents(walker.currentNode);
        return {
          x: rect.x,
          width: rect.width,
          height: rect.height,
          after: range.getBoundingClientRect().top,
          scrollHeight: table.closest("main")!.scrollHeight,
        };
      }
      throw new Error("Missing paragraph below the table");
    });
  const lead = page.getByRole("article").getByText("开头。");
  await expect(lead).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const before = await geometry();
  await lead.click({ position: { x: 2, y: 12 } });
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  const after = await geometry();
  for (const key of ["x", "width", "height", "after", "scrollHeight"] as const)
    expect.soft(Math.abs(after[key] - before[key]), key).toBeLessThanOrEqual(1);
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("末行");
  await expect
    .poll(
      async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
    )
    .toBe(markdown + "末行");
});

test("first keyboard entry starts on visible text after leading blanks", async ({ page }) => {
  const markdown = "\r\n\r\n岸边有一排木桩。";
  const { apiUrl } = await createNote(page, "键盘落点.md", markdown);
  const lead = page.getByRole("article").getByText("岸边有一排木桩。");
  await expect(lead).toBeVisible();
  await page.keyboard.press("Alt+e");
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  await page.keyboard.insertText("清晨，");
  await expect
    .poll(
      async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
    )
    .toBe(markdown.replace("岸边", "清晨，岸边"));
});
