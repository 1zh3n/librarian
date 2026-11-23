import { expect, test } from "@playwright/test";
import { signIn } from "./productFixture";

test("the app shell serves the public security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const headers = response.headers();
  const csp = headers["content-security-policy"] ?? "";
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ]) {
    expect(csp, `missing ${directive}`).toContain(directive);
  }
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("the rendered app does not report CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  await signIn(page, "reader", "reader-test-password");
  await page.goto("/");
  await expect(page.locator("#root")).not.toBeEmpty();
  expect(violations).toEqual([]);
});
