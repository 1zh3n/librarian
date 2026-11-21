import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

// The workspace title comes from the filename. The editable H1 is a single glyph.
const markdown = "# a\n\n\n\n啊\n\n\n啊\n\n啊\n啊\n";

async function headingPoint(heading: Locator, before: boolean) {
  return heading.evaluate((el, before) => {
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (text.nextNode()) {
      const node = text.currentNode;
      const offset = node.textContent?.indexOf("a") ?? -1;
      if (offset < 0) continue;
      const range = new Range();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width * (before ? 0.25 : 0.75), y: rect.top + rect.height / 2 };
    }
    throw new Error("Missing heading glyph");
  }, before);
}

for (const composing of [false, true]) {
  for (const immediate of [false, true]) {
    test(`clicking the heading ${composing ? "while composing at the document end" : "from reading"} keeps the insertion point ${immediate ? "during immediate input" : "after activation settles"}`, async ({
      page,
    }, info) => {
      const { apiUrl } = await createNote(
        page,
        `走查-${composing}-${immediate}-${info.repeatEachIndex}-${info.retry}/步行路线2.md`,
        markdown,
      );
      const article = page.getByRole("article");
      const editor = page.getByRole("textbox", { name: "Markdown 正文" });
      let heading = article.getByRole("heading", { name: "a", exact: true });
      if (composing) {
        await article.getByText("啊", { exact: true }).first().click();
        await editor.press("Control+End");
        const ime = await page.context().newCDPSession(page);
        await ime.send("Input.imeSetComposition", {
          text: "啊",
          selectionStart: 1,
          selectionEnd: 1,
        });
        heading = editor.locator('[data-preview-heading="1"]');
      }
      const point = await headingPoint(heading, immediate);
      await page.mouse.click(point.x, point.y);
      if (!immediate) {
        const samples = await editor.evaluate(
          (el) =>
            new Promise<(number | null)[]>((resolve) => {
              const frames: (number | null)[] = [];
              const start = performance.now();
              function sample() {
                const selection = document.getSelection();
                const line = el.querySelector(".cm-line");
                if (line && selection?.isCollapsed && line.contains(selection.focusNode)) {
                  const before = new Range();
                  before.selectNodeContents(line);
                  before.setEnd(selection.focusNode!, selection.focusOffset);
                  frames.push(before.toString().length);
                } else {
                  frames.push(null);
                }
                if (frames.length >= 24 && performance.now() - start >= 400) resolve(frames);
                else requestAnimationFrame(sample);
              }
              sample();
            }),
        );
        await info.attach("heading-caret.json", {
          body: JSON.stringify(samples),
          contentType: "application/json",
        });
        expect.soft([...new Set(samples)]).toEqual([3]);
      }
      if (!immediate) {
        const ime = await page.context().newCDPSession(page);
        await ime.send("Input.imeSetComposition", {
          text: "xu",
          selectionStart: 2,
          selectionEnd: 2,
        });
        await ime.send("Input.imeSetComposition", {
          text: "续",
          selectionStart: 1,
          selectionEnd: 1,
        });
      }
      await page.keyboard.insertText("续");
      const expected = (composing ? markdown + "啊" : markdown).replace(
        "# a",
        immediate ? "# 续a" : "# a续",
      );
      await expect
        .poll(
          async () =>
            ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
        )
        .toBe(expected);
    });
  }
}

for (const { finalBreak, selected } of [
  { finalBreak: "", selected: false },
  { finalBreak: "\n", selected: false },
  { finalBreak: "\n", selected: true },
]) {
  test(`a document refresh preserves the active heading when paragraphs arrive below it (final break ${Boolean(finalBreak)}, selected ${selected})`, async ({
    page,
  }, info) => {
    const {
      apiUrl,
      origin,
      document: original,
    } = await createNote(
      page,
      `同步-${finalBreak.length}-${selected}-${info.repeatEachIndex}-${info.retry}/步行路线2.md`,
      "# a" + finalBreak,
    );
    const heading = page.getByRole("article").getByRole("heading", { name: "a", exact: true });
    await expect(heading).toBeVisible();
    const remote = await page.request.put(apiUrl, {
      headers: { origin },
      data: { baseRevision: original.revision, markdown },
    });
    expect(remote.ok()).toBe(true);
    const point = await headingPoint(heading, false);
    await page.mouse.click(point.x, point.y);
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await expect(editor).toBeFocused();
    if (selected) await editor.press("Shift+ArrowLeft");
    await page.clock.setFixedTime(new Date(Date.now() + 60_000));
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(editor).toContainText("啊");
    if (selected) expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("a");
    await page.keyboard.insertText("续");
    await expect
      .poll(
        async () => ((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown,
      )
      .toBe(markdown.replace("# a", selected ? "# 续" : "# a续"));
  });
}
