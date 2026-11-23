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
  const counter = Math.floor(Date.now() / 30_000) + offset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
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

test("enrolls a dedicated account and signs in with a TOTP code", async ({ page }) => {
  await page.goto("/.auth/librarian/login");
  const origin = new URL(page.url()).origin;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const created = await page.request.post("/api/v1/accounts", {
    headers: { origin },
    data: { username: "totp-user", password: "totp-user-test-password" },
  });
  expect(created.status()).toBe(201);
  await page.request.post("/api/v1/session/logout", { headers: { origin } });

  await signIn(page, "totp-user", "totp-user-test-password");
  const started = await page.request.post("/api/v1/session/totp/start", {
    headers: { origin },
  });
  expect(started.ok()).toBe(true);
  const { secret } = (await started.json()) as { secret: string };
  const enrolled = await page.request.post("/api/v1/session/totp/verify", {
    headers: { origin },
    data: { secret, code: totp(secret) },
  });
  expect(enrolled.ok()).toBe(true);
  await page.request.post("/api/v1/session/logout", { headers: { origin } });

  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("totp-user");
  await page.getByLabel("密码", { exact: true }).fill("totp-user-test-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "两步验证" })).toBeVisible();
  await page.getByLabel("验证码或恢复码").fill(totp(secret, 1));
  await page.getByRole("button", { name: "验证" }).click();
  await expect(page).toHaveURL(`${origin}/`);
});
