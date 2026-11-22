import { expect, test } from "@playwright/test";
import { createNote } from "./productFixture";

test("clicking a folder row toggles it like vscode without changing file opening", async ({
  page,
}) => {
  const first = await createNote(page, "行点击/A.md", "# A\n\n第一行。\n");
  await createNote(page, "行点击/B.md", "# B\n\n第二行。\n");
  await page.goto(first.pathToNote);
  const tree = page.getByRole("treegrid", { name: "空间目录" });
  const folder = tree.getByRole("row", { name: /^行点击/ }).first();
  const child = tree.getByRole("row", { name: /^A/ }).first();

  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(child).toBeVisible();

  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(child).toBeHidden();

  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(child).toBeVisible();

  await folder.hover();
  await tree.getByRole("button", { name: "行点击更多" }).click();
  await expect(page.getByRole("menu", { name: "目录操作" })).toBeVisible();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
});
