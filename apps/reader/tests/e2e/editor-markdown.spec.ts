import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function mountEditor(page: Page, source: string, anchor = source.length) {
  await page.goto("/spike");
  const session = await page.evaluateHandle(
    async ({ source, anchor }) => {
      const path = "/src/editor/codemirror/adapter.ts";
      const { openEditor }: typeof import("../../src/editor/codemirror/adapter") = await import(
        /* @vite-ignore */ path
      );
      const editor = openEditor(source, { selection: { anchor, head: anchor } });
      const host = document.body.appendChild(document.createElement("div"));
      editor.mount(host);
      return editor;
    },
    { source, anchor },
  );
  return {
    session,
    input: page.getByRole("textbox", { name: "Markdown 正文" }),
    read: () => session.evaluate((editor) => editor.source()),
  };
}

for (const [title, start, continuation, exit] of [
  ["quote", "> 引文", "> ", ""],
  ["bullet", "- 正文", "- ", ""],
  ["ordered", "9) 正文", "10) ", ""],
  ["task", "- [x] 完成", "- [ ] ", ""],
  ["ordered task", "1. [x] 完成", "2. [ ] ", ""],
  ["nested list", "1. 父项\n   - 子项", "   - ", "2. "],
  ["quoted list", "> - 第一项", "> - ", "> "],
  ["nested quote", "> > 两层", "> > ", "> "],
] as const) {
  test(`Enter continues a ${title} and exits one empty level with undo`, async ({ page }) => {
    const { input, read, session } = await mountEditor(page, start);
    const next = start + "\n" + continuation;
    const outside = start + "\n" + exit;
    await input.press("Enter");
    expect(await read()).toBe(next);
    await input.press("Enter");
    expect(await read()).toBe(outside);
    expect(await session.evaluate((e) => e.selection().head)).toBe(outside.length);
    await input.press("Control+z");
    expect(await read()).toBe(next);
    await input.press("Control+y");
    expect(await read()).toBe(outside);
    await page.keyboard.insertText("下一段");
    expect(await read()).toBe(outside + "下一段");
  });
}

test("empty markers can be exited directly and fenced marker text stays literal", async ({
  page,
}) => {
  for (const [initial, expected] of [
    [">", ""],
    ["-", ""],
    ["12.", ""],
    ["- [ ]", ""],
    ["上一行\r\n\r\n> ", "上一行\r\n\r\n"],
    ["```md\n> ", "```md\n> \n"],
    ["> ```md\n> ", "> ```md\n> \n"],
  ] as const) {
    const { input, read } = await mountEditor(page, initial);
    await input.press("Enter");
    expect.soft(await read(), initial).toBe(expected);
    await input.press("Control+z");
    expect.soft(await read(), initial).toBe(initial);
  }
});

test("editing a nested task keeps the parent marker and other inline spans in preview", async ({
  page,
}) => {
  const source = "- 父项\n  - [ ] **待办** 和 *说明*";
  const { input, read, session } = await mountEditor(page, source, source.indexOf("办"));
  await expect(input.locator("[data-preview-list]")).toHaveText(["•"]);
  await expect(input).toContainText("- [ ] **待办**");
  await expect(input.locator("em")).toHaveText("说明");
  await page.keyboard.insertText("处");
  await session.evaluate((e) => e.select({ anchor: 0, head: 0 }));
  await expect(input.locator("strong")).toHaveText("待处办");
  await expect(input.locator("[data-preview-task=unchecked]")).toBeVisible();
  expect(await read()).toBe(source.replace("待办", "待处办"));
});

test("confirming an IME composition does not continue the quote", async ({ page }) => {
  const { input, read } = await mountEditor(page, "> ");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  await ime.send("Input.insertText", { text: "中文" });
  await expect.poll(read).toBe("> 中文");
  await input.press("Enter");
  expect(await read()).toBe("> 中文\n> ");
});

test("closing a typed inline span previews it as soon as the caret leaves", async ({ page }) => {
  const { input, read } = await mountEditor(page, "行首 ");
  await page.keyboard.insertText("**加粗**");
  await page.keyboard.insertText(" ");
  await expect(input.locator("strong")).toHaveText("加粗");
  await expect(input).not.toContainText("**");
  await input.locator("strong").click();
  await expect(input).toContainText("**加粗**");
  expect(await read()).toBe("行首 **加粗** ");
});

test("splitting an ordered task carries its suffix and renumbers later siblings atomically", async ({
  page,
}) => {
  const original = "9) [x] 上下\r\n10) 后项";
  const { input, read } = await mountEditor(page, original, original.indexOf("下"));
  await input.press("Enter");
  expect(await read()).toBe("9) [x] 上\n10) [ ] 下\r\n11) 后项");
  await input.press("Control+z");
  expect(await read()).toBe(original);
});

test("IME confirmation before the first preedit leaves Enter to the input method", async ({
  page,
}) => {
  const { input, read } = await mountEditor(page, "> ");
  await input.dispatchEvent("compositionstart");
  const allowed = await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(allowed).toBe(true);
  expect(await read()).toBe("> ");
});

test("Enter before a checkbox preserves the Markdown to the right of the caret", async ({
  page,
}) => {
  const original = "- [ ]";
  const { input, read } = await mountEditor(page, original, 2);
  await input.press("Enter");
  expect(await read()).toBe("-\n- [ ]");
  await input.press("Control+z");
  expect(await read()).toBe(original);
});
