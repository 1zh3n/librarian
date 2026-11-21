import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSummary, Workspace } from "../../src/api/client";
import { createNote, openFieldWorkspace } from "./productFixture";

async function readFromField(page: Page) {
  const field = await openFieldWorkspace(page);
  const documents = (await (
    await page.request.get(`/api/v1/workspaces/${field.id}/documents`)
  ).json()) as DocumentSummary[];
  const note = documents.find((document) => document.path === "野外/02.md");
  if (!note) throw new Error("Missing field note");
  const original = `/workspaces/${field.id}/documents/${note.id}`;
  await page.goto(original);
  await expect(page.getByRole("article")).toContainText("清晨听见鸟鸣。");
  return original;
}

test("the create command keeps the source directory at its label and its far edge", async ({
  page,
}) => {
  const original = await readFromField(page);
  const picker = page.getByRole("button", { name: /田野笔记/ });
  const form = page.getByRole("form", { name: "新建空间" });
  const name = form.getByRole("textbox", { name: "空间名称" });
  for (const side of ["label", "edge"]) {
    // Keep a scrollable menu in the edge case even on a fresh fixture.
    if (side === "edge") await page.setViewportSize({ width: 1280, height: 320 });
    await picker.click();
    const command = page.getByRole("menuitem", { name: "新建空间", exact: true });
    await command.scrollIntoViewIfNeeded();
    if (side === "edge") {
      const menu = page.getByRole("menu", { name: "空间" });
      expect(await menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }
    const point = await command.evaluate((item, side) => {
      const row = item.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(item);
      const label = text.getBoundingClientRect();
      return { x: side === "label" ? label.left + 4 : row.right - 3, y: row.top + row.height / 2 };
    }, side);
    await page.mouse.move(point.x, point.y);
    const hit = await command.evaluate((item, { x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        onCommand: item.contains(target),
        cursor: target && getComputedStyle(target).cursor,
      };
    }, point);
    expect(hit, side).toEqual({ onCommand: true, cursor: "pointer" });
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL("/workspaces/new");
    await expect(form).toBeVisible();
    await expect(picker).toBeVisible();
    await expect(page.getByRole("row", { name: /野外/ })).toBeVisible();
    if (side === "label") {
      await page.reload();
      await expect(picker).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(original);
    }
  }
  await name.fill("从田野笔记新建");
  await form.getByRole("button", { name: "创建空间" }).click();
  await expect(page).toHaveURL(/\/workspaces\/[^/]+\/manage$/);
  await expect(page.getByRole("heading", { name: "从田野笔记新建", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /从田野笔记新建/ })).toBeVisible();
});

test("dismissing the picker and reselecting the current workspace preserve the open note", async ({
  page,
}) => {
  const original = await readFromField(page);
  const picker = page.getByRole("button", { name: /田野笔记/ });
  const current = page.getByRole("menuitemradio", { name: "田野笔记", exact: true });
  await picker.press("ArrowDown");
  await expect(current).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(picker).toBeFocused();
  await expect(page).toHaveURL(original);
  await picker.click();
  await page.mouse.click(1_000, 30);
  await expect(current).toBeHidden();
  await expect(page).toHaveURL(original);
  await picker.click();
  await current.click();
  await expect(current).toBeHidden();
  await expect(page).toHaveURL(original);
  await picker.click();
  await page.getByRole("menuitemradio", { name: "另一空间", exact: true }).click();
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const other = workspaces.find((workspace) => workspace.name === "另一空间");
  if (!other) throw new Error("Missing other workspace");
  await expect(page).toHaveURL(new RegExp(`/workspaces/${other.id}/documents/`));
  const otherPicker = page.getByRole("button", { name: /另一空间/ });
  await otherPicker.press("Enter");
  await page.keyboard.press("End");
  const create = page.getByRole("menuitem", { name: "新建空间", exact: true });
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("form", { name: "新建空间" })).toBeVisible();
  await expect(otherPicker).toBeVisible();
  await expect(page.getByRole("textbox", { name: "空间名称" })).toBeFocused();
});

test("declining to leave a draft for the new workspace form stays in the source workspace", async ({
  page,
}) => {
  const { apiUrl, pathToNote } = await createNote(page, "空间创建草稿.md", "未离开的正文。");
  await page.route(`**${apiUrl}`, async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page
    .getByRole("article")
    .getByText("未离开的正文。")
    .click({ position: { x: 8, y: 16 } });
  await page.getByRole("textbox", { name: "Markdown 正文" }).press("End");
  await page.keyboard.insertText("保留草稿");
  const picker = page.getByRole("button", { name: /田野笔记/ });
  await picker.click();
  await Promise.all([
    page.waitForEvent("dialog").then((question) => question.dismiss()),
    page.getByRole("menuitem", { name: "新建空间", exact: true }).click(),
  ]);
  await expect(page).toHaveURL(pathToNote);
  await expect(page.getByRole("article")).toContainText("保留草稿");
  await expect(picker).toBeVisible();
});
