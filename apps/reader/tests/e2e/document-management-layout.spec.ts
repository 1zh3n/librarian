import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { signIn } from "./productFixture";

async function fieldWorkspace(page: Page) {
  const spaces = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    id: string;
    name: string;
  }[];
  const workspace = spaces.find((space) => space.name === "田野笔记");
  if (!workspace) throw new Error("Missing field Workspace");
  return workspace;
}

test("management page states the role and aligns its primary action", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspace = await fieldWorkspace(page);
  await page.goto(`/workspaces/${workspace.id}/manage`);

  await expect(page.getByRole("heading", { name: "田野笔记" })).toBeVisible();
  await expect(page.getByText("管理员", { exact: true })).toBeVisible();
  await expect(page.getByText("管理空间名称、成员、外部导入、备份与发布。")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "空间设置" })).toBeVisible();

  const form = page.getByRole("form", { name: "空间设置" });
  const save = form.getByRole("button", { name: "保存空间设置" });
  const [formBox, buttonBox] = await Promise.all([form.boundingBox(), save.boundingBox()]);
  if (!formBox || !buttonBox) throw new Error("Expected the management form and save action");
  expect(Math.abs(buttonBox.x + buttonBox.width - (formBox.x + formBox.width))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("management-1440.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  const [narrowForm, narrowButton] = await Promise.all([form.boundingBox(), save.boundingBox()]);
  if (!narrowForm || !narrowButton) throw new Error("Expected the narrow management form");
  expect(narrowButton.width).toBeGreaterThan(narrowForm.width * 0.9);
  expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBe(390);
});
