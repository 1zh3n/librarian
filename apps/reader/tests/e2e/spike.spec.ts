import { expect, test } from "@playwright/test";

test("serves the spike document", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
});

test("spike_startup", async ({ page }) => {
  await page.goto("/");
  const document = page.getByRole("article", { name: "测试文档" });
  await expect(document.getByRole("heading", { name: "河边的笔记" })).toBeVisible();
  await page.getByRole("button", { name: "编辑正文" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
});
