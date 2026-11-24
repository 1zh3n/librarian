import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signIn } from "./productFixture";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(value: string): Buffer {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of value.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("invalid base32 secret");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret: string, offset = 0): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const digest = createHmac("sha1", base32(secret)).update(message).digest();
  const start = (digest.at(-1) ?? 0) & 0x0f;
  const value =
    ((((digest[start] ?? 0) & 0x7f) << 24) |
      ((digest[start + 1] ?? 0) << 16) |
      ((digest[start + 2] ?? 0) << 8) |
      (digest[start + 3] ?? 0)) %
    1_000_000;
  return String(value).padStart(6, "0");
}

test("accepts an invite and signs in with the new TOTP account", async ({ page }) => {
  await page.goto("/.auth/librarian/login");
  const origin = new URL(page.url()).origin;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspaceResponse = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: "邀请验收空间" },
  });
  expect(workspaceResponse.status()).toBe(201);
  const workspace = (await workspaceResponse.json()) as { id: string };
  const inviteResponse = await page.request.post("/api/v1/invites", {
    headers: { origin },
    data: {
      username: "invite-playwright",
      admin: false,
      role: "write",
      workspaceIds: [workspace.id],
      expiresInDays: 7,
    },
  });
  expect(inviteResponse.status()).toBe(201);
  const invite = (await inviteResponse.json()) as { token: string };

  await page.goto(`/.auth/librarian/invite?token=${invite.token}`);
  await expect(page.getByRole("heading", { name: "接受邀请" })).toBeVisible();
  const acceptForm = page.getByRole("form", { name: "接受邀请" });
  const qr = page.getByRole("img", { name: "TOTP 二维码" });
  await expect(qr).toBeVisible();
  await expect
    .poll(() => qr.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const secret = (await page.locator("p code").first().textContent())?.trim() ?? "";
  expect(secret.length).toBeGreaterThanOrEqual(32);
  const password = page.getByLabel("设置密码", { exact: true });
  const confirmation = page.getByLabel("确认密码", { exact: true });
  await password.fill("invite-playwright-password");
  await confirmation.fill("invite-playwright-password-typo");
  await page.getByLabel("验证器验证码").fill("123456");
  let acceptRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/accept")) acceptRequests += 1;
  });
  await page.getByRole("button", { name: "接受邀请" }).click();
  await expect(acceptForm.getByRole("alert")).toHaveText("两次输入的密码不一致。");
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toHaveAccessibleDescription("两次输入的密码不一致。");
  await expect(password).toHaveValue("invite-playwright-password");
  await expect(confirmation).toHaveValue("invite-playwright-password-typo");
  expect(acceptRequests).toBe(0);

  const revealPassword = page.getByRole("button", { name: "显示密码" });
  const revealConfirmation = page.getByRole("button", { name: "显示确认密码" });
  await revealPassword.click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(confirmation).toHaveAttribute("type", "password");
  await revealConfirmation.click();
  await expect(confirmation).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏密码" }).click();
  await expect(password).toHaveAttribute("type", "password");

  await confirmation.fill("invite-playwright-password");
  await page.getByLabel("验证器验证码").fill(totp(secret));
  await page.getByRole("button", { name: "接受邀请" }).click();
  await expect(page.getByRole("heading", { name: "邀请已接受" })).toBeVisible();
  expect(acceptRequests).toBe(1);
  await expect(page.getByRole("list", { name: "恢复码" }).locator("li")).toHaveCount(10);

  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("invite-playwright");
  await page.getByLabel("密码", { exact: true }).fill("invite-playwright-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "两步验证" })).toBeVisible();
  await page.getByLabel("验证码或恢复码").fill(totp(secret, 1));
  await page.getByRole("button", { name: "验证" }).click();
  await expect(page).toHaveURL(`${origin}/`);
});

test("creates an invite from the administrator account page", async ({ page }) => {
  await page.goto("/.auth/librarian/login");
  const origin = new URL(page.url()).origin;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspaceResponse = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: "邀请 UI 空间" },
  });
  expect(workspaceResponse.status()).toBe(201);
  await page.goto("/accounts");
  const form = page.getByRole("form", { name: "邀请新成员" });
  await form.getByLabel("用户名").fill("invite-ui-user");
  const workspaceCheckbox = form.getByRole("checkbox", { name: "邀请 UI 空间" });
  await workspaceCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(workspaceCheckbox).toBeChecked();
  await form.getByRole("button", { name: "创建邀请" }).click();
  const section = page.getByRole("region", { name: "邀请新成员" });
  await expect(section.getByText("邀请链接只显示一次")).toBeVisible();
  await expect(section.getByText(/\/\.auth\/librarian\/invite\?token=/u)).toBeVisible();
  await expect(section.getByText("invite-ui-user").first()).toBeVisible();
});

test("labels an administrator invitation before acceptance", async ({ page }) => {
  await page.goto("/.auth/librarian/login");
  const origin = new URL(page.url()).origin;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const response = await page.request.post("/api/v1/invites", {
    headers: { origin },
    data: {
      username: "bootstrap-admin-ui",
      admin: true,
      role: "write",
      workspaceIds: [],
      expiresInDays: 1,
    },
  });
  expect(response.status()).toBe(201);
  const invite = (await response.json()) as { token: string };
  await page.goto(`/.auth/librarian/invite?token=${invite.token}`);
  await expect(page.getByText("管理员邀请", { exact: false })).toBeVisible();
  await expect(page.getByText("服务器管理员权限", { exact: false })).toBeVisible();
});

test("fits the invite form at 320 px with double-size text", async ({ page }) => {
  await page.goto("/.auth/librarian/login");
  const origin = new URL(page.url()).origin;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const response = await page.request.post("/api/v1/invites", {
    headers: { origin },
    data: {
      username: "invite-narrow-ui",
      admin: false,
      role: "write",
      workspaceIds: [],
      expiresInDays: 1,
    },
  });
  expect(response.status()).toBe(201);
  const invite = (await response.json()) as { token: string };
  await page.setViewportSize({ width: 320, height: 820 });
  await page.goto(`/.auth/librarian/invite?token=${invite.token}`);
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  await expect(page.getByLabel("确认密码", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
