import { expect, test } from "@playwright/test";
import { openFieldWorkspace } from "./productFixture";

test("returns to an invalid expiry with the space draft intact", async ({ page }) => {
  await openFieldWorkspace(page);
  await page.goto("/workspaces/new");
  const form = page.getByRole("form", { name: "新建空间" });
  const name = form.getByLabel("空间名称");
  await name.fill("临时资料");
  await form.getByRole("button", { name: "高级选项" }).click();
  await form.getByRole("button", { name: /空间用途/ }).click();
  await page.getByRole("option", { name: "外部文档接收" }).click();
  await form.getByRole("button", { name: /保留方式/ }).click();
  await page.getByRole("option", { name: "临时保存" }).click();
  const expires = form.getByLabel("到期时间");
  await expires.fill("2000-01-01T12:00");
  await form.getByRole("button", { name: "高级选项" }).click();
  await form.getByRole("button", { name: "创建空间" }).click();
  await expect(form.getByRole("alert")).toHaveText("到期时间必须晚于现在。");
  await expect(expires).toBeFocused();
  await expect(expires).toHaveAttribute("aria-invalid", "true");
  await expect(expires).toHaveAccessibleDescription("到期时间必须晚于现在。");
  await expect(name).toHaveValue("临时资料");
  await expires.fill("2099-01-01T12:00");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await form.getByRole("button", { name: "创建空间" }).click();
  await expect(page).toHaveURL(/\/manage$/u);
});
