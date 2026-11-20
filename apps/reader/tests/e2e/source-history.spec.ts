import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { EditorSession } from "../../src/editor/codemirror/adapter";

async function open(page: Page, source: string, selection: { anchor: number; head: number }) {
  await page.goto("/");
  const session = await page.evaluateHandle(
    async ({ source, selection }): Promise<EditorSession> => {
      const modulePath = "/src/editor/codemirror/adapter.ts";
      const { openEditor } = await import(/* @vite-ignore */ modulePath);
      const session = openEditor(source, { revision: "r1", selection });
      const parent = document.createElement("div");
      document.body.append(parent);
      session.mount(parent);
      session.setSourceMode(true);
      return session;
    },
    { source, selection },
  );
  return { session, editor: page.getByRole("textbox", { name: "Markdown 正文" }) };
}

test("undo_and_redo_restore_exact_mixed_line_endings", async ({ page }) => {
  const original = "甲\r\n乙\r丙\n丁";
  const { editor, session } = await open(page, original, { anchor: 1, head: 5 });
  await editor.press("Backspace");
  expect(await session.evaluate((editor) => editor.source())).toBe("甲丙\n丁");
  await editor.press("Control+z");
  expect(await session.evaluate((editor) => editor.source())).toBe(original);
  await editor.press("Control+Shift+z");
  expect(await session.evaluate((editor) => editor.source())).toBe("甲丙\n丁");
  await editor.press("Control+z");
  await expect(editor.locator(".cm-line")).toHaveText(["甲", "乙", "丙", "丁"]);
  expect(
    await session.evaluate((editor) =>
      editor.applyExternal({ baseRevision: "r1", revision: "r2", edits: [] }),
    ),
  ).toBe("applied");
});

test("native_edit_reconciles_adjacent_cr_and_lf", async ({ page }) => {
  const { editor, session } = await open(page, "A\rX\nB", { anchor: 2, head: 3 });
  await editor.press("Backspace");
  expect(await session.evaluate((editor) => editor.source())).toBe("A\r\nB");
  await expect(editor.locator(".cm-line")).toHaveText(["A", "B"], { timeout: 1500 });
  await editor.press("Control+End");
  await editor.press("Home");
  await page.keyboard.insertText("中");
  expect(await session.evaluate((editor) => editor.source())).toBe("A\r\n中B");
});
