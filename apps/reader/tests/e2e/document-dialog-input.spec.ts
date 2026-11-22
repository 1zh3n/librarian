import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DevicePreferences, DocumentSummary } from "../../src/api/client";
import { createNote } from "./productFixture";

async function delayNextWrite(
  page: Page,
  endpoint: string,
  method: string,
  outcome: "fail" | "save",
) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route(endpoint, async (route) => {
    if (started || route.request().method() !== method) {
      await route.continue();
      return;
    }
    started = true;
    await gate;
    if (outcome === "fail") await route.fulfill({ status: 503 });
    else await route.continue();
  });
  return { wait: () => expect.poll(() => started).toBe(true), release };
}

test("keeps the submitted name and folder until creation finishes, and reopens them on failure", async ({
  page,
}) => {
  const { document } = await createNote(page, "观测/新建回执.md", "从目录继续写。");
  const row = page.getByRole("row", { name: "新建回执", exact: true });
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "新建文档…" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  const name = dialog.getByLabel("文档名称");
  const directory = dialog.getByLabel("目录（可选）");
  await name.fill("初次提交");
  const endpoint = `/api/v1/workspaces/${document.document.workspaceId}/documents`;
  const held = await delayNextWrite(page, endpoint, "POST", "fail");
  await name.press("Enter");
  try {
    await held.wait();
    await expect(name).not.toBeEditable();
    await expect(directory).not.toBeEditable();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    held.release();
  }
  await expect(dialog.getByRole("alert")).toContainText("重试");
  await expect(name).toHaveValue("初次提交");
  await expect(directory).toHaveValue("观测");
  await name.fill("校对后标题");
  await directory.fill("观测/重试");
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  const notes = (await (await page.request.get(endpoint)).json()) as DocumentSummary[];
  expect(notes.map((note) => note.path)).toContain("观测/重试/校对后标题.md");
});

test("keeps submitted reading preferences until the response and allows a corrected retry", async ({
  page,
}) => {
  await createNote(page, "设置回执.md", "等待读取设置。");
  const trigger = page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  await dialog.getByRole("tab", { name: "阅读", exact: true }).click();
  const size = dialog.getByLabel("字号", { exact: true });
  const device = await page.evaluate(() => localStorage.getItem("librarian.device"));
  const endpoint = `/api/v1/settings/devices/${device}`;
  const held = await delayNextWrite(page, endpoint, "PUT", "fail");
  await size.fill("21");
  try {
    await held.wait();
    await expect(size).not.toBeEditable();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    held.release();
  }
  await expect(dialog.getByRole("alert")).toContainText("无法保存设置");
  await expect(dialog.getByRole("button", { name: "重试" })).toBeVisible();
  await expect(size).toHaveValue("21");
  const retry = await delayNextWrite(page, endpoint, "PUT", "save");
  await size.fill("25");
  const motion = dialog.getByRole("checkbox", { name: "减少动画" });
  await motion.press("Space");
  await expect(motion).toBeChecked();
  try {
    await retry.wait();
    await expect(motion).toBeDisabled();
    for (const name of [/主题/, /字体/]) {
      const choice = dialog.getByRole("button", { name });
      await expect(choice).toBeDisabled();
      const bounds = await choice.boundingBox();
      if (!bounds) throw new Error("Expected a visible preference selector");
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(page.getByRole("listbox")).toHaveCount(0);
    }
    const label = await dialog.getByText("减少动画", { exact: true }).boundingBox();
    if (!label) throw new Error("Expected a visible motion preference");
    await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
    await expect(motion).toBeChecked();
  } finally {
    retry.release();
  }
  await expect(dialog.getByText("已保存")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭应用设置" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  const saved = (await (await page.request.get(endpoint)).json()) as DevicePreferences;
  expect(saved).toMatchObject({ fontSize: 25, reduceMotion: true });
});

test("the command palette keeps editing shortcuts inside the dialog and returns focus to the article", async ({
  page,
}) => {
  await createNote(page, "搜索快捷键.md", "这一段继续阅读。");
  const article = page.getByRole("article");
  await article.press("Control+k");
  const input = page.getByRole("searchbox");
  await input.fill("查找线索");
  for (const shortcut of ["Alt+e", "Alt+Shift+e"]) {
    await input.press(shortcut);
    await expect(input).toBeFocused();
    // Modal dialogs hide the background from the accessibility tree.
    await expect(
      page.getByRole("textbox", { name: "Markdown 正文", includeHidden: true }),
    ).toHaveCount(0);
    await expect(page.locator("article")).toContainText("这一段继续阅读。");
  }
  await page.keyboard.insertText("续");
  await expect(input).toHaveValue("查找线索续");
  await input.press("Escape");
  await expect(article).toBeFocused();
  await article.press("Alt+e");
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
});
