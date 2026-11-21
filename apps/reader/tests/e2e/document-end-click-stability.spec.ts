import { expect, test } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

const sections = Array.from(
  { length: 32 },
  (_, i) =>
    `## 第${i + 1}站\n\n` + "沿着堤岸核对清晨的水位，把沙纹和新发现的脚印记进手册。".repeat(3),
);
const ending = "最后的记录停在白鹭";
const body = [...sections, ending].join("\n\n");
type Frame = {
  ms: number;
  clicked: boolean;
  glyphY: number | null;
  scrollTop: number;
  caret: { y: number; visible: boolean } | null;
  originalEditorFocused: boolean;
};

for (const { name, width, tail, editing, outer = false } of [
  { name: "append the first newline", width: 1440, tail: "", editing: false },
  {
    name: "reuse three trailing blank lines on narrow paper",
    width: 390,
    tail: "\n".repeat(3),
    editing: false,
  },
  {
    name: "preserve twelve trailing blank lines and final indentation",
    width: 1440,
    tail: "\n".repeat(12) + "    ",
    editing: false,
  },
  { name: "append while already editing", width: 1440, tail: "", editing: true },
  {
    name: "keep the editor focused at the outer paper edge",
    width: 1440,
    tail: "",
    editing: true,
    outer: true,
  },
]) {
  test(`click below the final paragraph at the real scroll bottom: ${name}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const source = body + tail;
    const { apiUrl } = await createNote(
      page,
      `底部-${width}-${tail.length}-${editing}-${outer}-${info.repeatEachIndex}-${info.retry}.md`,
      source,
    );
    const article = page.getByRole("article");
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await expect(article.getByText(ending, { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (editing) {
      await article.getByText(ending, { exact: true }).click();
      await expect(editor).toBeFocused();
    }
    const main = page.getByRole("main");
    await expect
      .poll(() =>
        main.evaluate(async (el) => {
          el.scrollTop = el.scrollHeight;
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          return el.scrollHeight - el.clientHeight - el.scrollTop;
        }),
      )
      .toBeLessThanOrEqual(1);

    const probe = await main.evaluateHandle(
      (main, { lastGlyph, outer }) => {
        function glyphRect() {
          const root =
            main.querySelector('[contenteditable="true"][aria-label="Markdown 正文"]') ??
            main.querySelector("article");
          if (!root) return null;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            const index = node.textContent?.indexOf(lastGlyph) ?? -1;
            if (index < 0) continue;
            const range = new Range();
            range.setStart(node, index);
            range.setEnd(node, index + lastGlyph.length);
            return range.getBoundingClientRect();
          }
          return null;
        }
        function measureCaret() {
          const editor = document.activeElement;
          const selection = document.getSelection();
          if (
            !editor?.matches('[contenteditable="true"][aria-label="Markdown 正文"]') ||
            !selection?.isCollapsed ||
            !selection.rangeCount ||
            !editor.contains(selection.focusNode)
          )
            return null;
          const range = selection.getRangeAt(0).cloneRange();
          // Chromium represents the insertion point on an empty contenteditable line with a BR.
          const br = range.startContainer.childNodes[range.startOffset];
          if (!range.getBoundingClientRect().height && br instanceof HTMLBRElement)
            range.selectNode(br);
          const caret = range.getBoundingClientRect();
          const view = main.getBoundingClientRect();
          if (!caret.height) return null;
          const visible =
            caret.top >= view.top &&
            caret.bottom <= view.bottom &&
            editor.contains(
              document.elementFromPoint(caret.left + 1, caret.top + caret.height / 2),
            );
          return { y: caret.top, visible };
        }
        const glyph = glyphRect();
        const view = main.getBoundingClientRect();
        const x = outer ? view.left + 8 : glyph && glyph.left + glyph.width / 2;
        const y = view.bottom - 8;
        const column = main.querySelector("[data-reading-measure]")!;
        if (
          !glyph ||
          x == null ||
          glyph.top < view.top ||
          glyph.bottom + 8 >= y ||
          main.scrollTop < main.clientHeight ||
          main.scrollHeight - main.clientHeight - main.scrollTop > 1 ||
          !main.contains(document.elementFromPoint(x, y))
        )
          throw new Error("Expected visible final glyph and blank paper at the scroll limit");
        if (
          outer &&
          (x >= column.getBoundingClientRect().left ||
            column.contains(document.elementFromPoint(x, y)))
        )
          throw new Error("Expected the outer edge to hit paper outside the text column");
        const originalEditor = main.querySelector(
          '[contenteditable="true"][aria-label="Markdown 正文"]',
        );
        const focusLosses: number[] = [];
        const frames = new Promise<Frame[]>((resolve) => {
          main.addEventListener(
            "pointerdown",
            () => {
              const start = performance.now();
              // A blur and refocus in one frame still interrupts editing.
              const onFocusOut = () => focusLosses.push(performance.now() - start);
              originalEditor?.addEventListener("focusout", onFocusOut);
              const samples: Frame[] = [];
              let clickedAt: number | undefined;
              let clickedFrames = 0;
              main.addEventListener(
                "click",
                () => {
                  clickedAt = performance.now();
                },
                { capture: true, once: true },
              );
              function sample() {
                const ms = performance.now() - start;
                samples.push({
                  ms,
                  clicked: clickedAt !== undefined,
                  glyphY: glyphRect()?.top ?? null,
                  scrollTop: main.scrollTop,
                  caret: measureCaret(),
                  originalEditorFocused:
                    originalEditor !== null && document.activeElement === originalEditor,
                });
                if (
                  clickedAt !== undefined &&
                  ++clickedFrames >= 24 &&
                  performance.now() - clickedAt >= 400
                ) {
                  originalEditor?.removeEventListener("focusout", onFocusOut);
                  resolve(samples);
                } else requestAnimationFrame(sample);
              }
              requestAnimationFrame(sample);
            },
            { capture: true, once: true },
          );
        });
        return {
          point: {
            x,
            y,
            glyphY: glyph.top,
            scrollTop: main.scrollTop,
            columnLeft: column.getBoundingClientRect().left,
          },
          frames,
          focusLosses,
        };
      },
      { lastGlyph: "鹭", outer },
    );
    const point = await probe.evaluate((p) => p.point);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    // Sample the browser's mousedown handling before releasing the real pointer.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    await page.mouse.up();
    const frames = await probe.evaluate((p) => p.frames);
    const focusLosses = await probe.evaluate((p) => p.focusLosses);
    await info.attach("end-click-frames.json", {
      body: JSON.stringify({ point, frames, focusLosses }, null, 2),
      contentType: "application/json",
    });
    await expect(editor).toBeFocused();
    const ready = tail ? source : source + "\n";
    const saved = () =>
      expect.poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      );
    await saved().toBe(ready);
    await page.keyboard.insertText("续写");
    await saved().toBe(ready + "续写");
    expect(frames.some((frame) => !frame.clicked)).toBe(true);
    if (editing) {
      expect.soft(focusLosses, "Editor focusout after pointerdown (ms)").toEqual([]);
      expect
        .soft(
          frames.filter((frame) => !frame.originalEditorFocused),
          "The same editor must retain focus in every frame",
        )
        .toEqual([]);
    }
    expect
      .soft(
        frames.filter((f) => f.glyphY === null || Math.abs(f.glyphY - point.glyphY) > 1),
        `Last glyph started at y=${point.glyphY}`,
      )
      .toEqual([]);
    expect(
      frames.filter((f) => f.clicked && !f.caret?.visible),
      "The insertion caret must be visible on the blank line",
    ).toEqual([]);
  });
}
