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
  const reveal = page.getByRole("button", { name: "显示密码" });
  await password.press("Tab");
  await expect(reveal).toBeFocused();
  await expect(reveal.locator('[data-icon="eye"]')).toBeVisible();
  const input = await password.boundingBox();
  const control = await reveal.boundingBox();
  if (!input || !control) throw new Error("Missing password control");
  expect(control.x).toBeGreaterThanOrEqual(input.x);
  expect(control.y).toBeGreaterThanOrEqual(input.y);
  expect(control.x + control.width).toBeLessThanOrEqual(input.x + input.width);
  expect(control.y + control.height).toBeLessThanOrEqual(input.y + input.height);
  expect(control.width).toBeGreaterThanOrEqual(44);
  expect(control.height).toBeGreaterThanOrEqual(44);
});

test("signs in on a narrow screen after showing and correcting a password", async ({ page }) => {
  await page.goto("/.auth/librarian/login?next=%2Faccounts%3Ffrom%3Dreader");
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
  const hide = page.getByRole("button", { name: "隐藏密码" });
  await expect(hide.locator('[data-icon="eye-off"]')).toBeVisible();
  await hide.click();
  await expect(password).toHaveAttribute("type", "password");

  const failed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const failure = await failed;
  expect(failure.status()).toBe(401);
  expect(failure.headers()["cache-control"]).toBe("no-store");
  expect(await failure.text()).not.toContain("incorrect-fixture-password");
  expect(await page.context().cookies()).toHaveLength(0);
  expect((await page.request.get("/api/v1/workspaces")).status()).toBe(401);
  await expect(page.getByRole("alert")).toHaveText("用户名或密码不正确，请重试。");
  await expect(password).toHaveValue("");

  await expect(username).toHaveValue("fixture-admin");
  await expect(password).toBeFocused();
  await expect(password).toHaveAccessibleDescription("用户名或密码不正确，请重试。");
  await page.keyboard.press("Shift+Tab");
  await expect(username).toBeFocused();
  await expect(username).toHaveAccessibleDescription("用户名或密码不正确，请重试。");
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await page.keyboard.type("fixture-admin-test-password");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/accounts\?from=reader$/u);
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();
});

test("keeps a mistyped username as literal text only on the failed submission", async ({
  page,
}) => {
  const login = "/.auth/librarian/login";
  const name = '林 & "溪" <reader>';
  const username = page.getByLabel("用户名", { exact: true });
  const password = page.getByLabel("密码", { exact: true });
  await page.goto(login);
  await username.fill(name);
  await password.fill("mistyped-password");
  await password.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("用户名或密码不正确，请重试。");
  await expect(username).toHaveValue(name);
  await expect(password).toHaveValue("");
  await expect(page).toHaveURL(login);
  await page.goto(login);
  await expect(username).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("rejects foreign login origins and external return addresses", async ({
  request,
  baseURL,
}) => {
  const login = "/.auth/librarian/login";
  const form = { username: "fixture-admin", password: "fixture-admin-test-password" };
  const foreign = "https://example.test";
  const externalReturn = login + "?next=" + encodeURIComponent(foreign);
  expect((await request.get(externalReturn)).status()).toBe(400);
  for (const [url, origin, status] of [
    [externalReturn, baseURL!, 400],
    [login, foreign, 403],
  ] as const) {
    const denied = await request.post(url, { form, headers: { origin }, maxRedirects: 0 });
    expect(denied.status()).toBe(status);
    expect(denied.headers()["set-cookie"]).toBeUndefined();
  }
});
