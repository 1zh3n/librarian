import { expect, test } from "@playwright/test";
import { createNote } from "./productFixture";

test("clicking a folder row toggles it like vscode without changing file opening", async ({
  page,
}) => {
  const first = await createNote(page, "行点击/A.md", "# A\n\n第一行。\n");
  await createNote(page, "行点击/B.md", "# B\n\n第二行。\n");
  await createNote(page, "根文件.md", "# 根文件\n");
  await page.goto(first.pathToNote);
  const tree = page.getByRole("treegrid", { name: "空间目录" });
  const folder = tree.getByRole("row", { name: /^行点击/ }).first();
  const child = tree.getByRole("row", { name: "A.md", exact: true });
  const rootFile = tree.getByRole("row", { name: "根文件.md", exact: true });

  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(child).toBeVisible();
  const folderLabel = await folder.locator("span[title]").first().boundingBox();
  const rootLabel = await rootFile.locator("span[title]").first().boundingBox();
  expect(Math.abs((folderLabel?.x ?? 0) - (rootLabel?.x ?? 0))).toBeLessThanOrEqual(1);

  await expect(tree.getByRole("button", { name: "行点击更多" })).toHaveCount(0);
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(child).toBeHidden();

  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(child).toBeVisible();

  await folder.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "目录操作" })).toBeVisible();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
});
