import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 360, height: 720 }, hasTouch: true });

test("keeps the login fields usable at 320 px with 200 percent text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await page.goto("/.auth/librarian/login");
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  const password = page.getByLabel("密码", { exact: true });
  await expect(password).toBeVisible();
  expect((await password.boundingBox())?.width).toBeGreaterThanOrEqual(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await password.press("Tab");
  await expect(page.getByRole("button", { name: "显示密码" })).toBeFocused();
});

test("signs in on a narrow screen after showing and correcting a password", async ({ page }) => {
  await page.goto("/.auth/librarian/login?next=%2Faccounts");
  await expect(page.getByRole("heading", { name: "登录 Librarian" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  const username = page.getByLabel("用户名", { exact: true });
  const password = page.getByLabel("密码", { exact: true });
  await expect(username).toHaveAttribute("autocomplete", "username");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await username.fill("fixture-admin");
  await password.fill("incorrect-fixture-password");
  await password.press("Tab");
  await expect(page.getByRole("button", { name: "显示密码" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏密码" }).click();
  await expect(password).toHaveAttribute("type", "password");

  const failed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  expect((await failed).status()).toBe(401);
  await expect(page.getByRole("alert")).toHaveText("用户名或密码不正确，请重试。");
  await expect(password).toHaveValue("");

  await username.fill("fixture-admin");
  await password.fill("fixture-admin-test-password");
  await password.press("Enter");
  await expect(page).toHaveURL(/\/accounts$/u);
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();
});
