import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createNote, signIn } from "./productFixture";

async function enterAi(page: Page) {
  const button = page.getByRole("banner").getByRole("button", { name: "AI", exact: true });
  await expect(button).toHaveText("AI");
  await button.click();
  await expect(page).toHaveURL(/\/ai$/u);
  await expect(page.getByRole("main").getByRole("heading", { name: "AI 助手" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "提示词" })).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`opens AI in one click from a document at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const { pathToNote } = await createNote(page, `助手入口-${width}.md`, "一键打开对话。");
    await enterAi(page);
    await expect(page).toHaveURL("/ai");
    await page.goBack();
    await expect(page).toHaveURL(pathToNote);
    await expect(page.getByText("一键打开对话。", { exact: true })).toBeVisible();
  });
}

test("the document and assistant headers fit a 320px window at twice the text size", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await createNote(page, "窄屏入口.md", "使用顶栏进入助手。");
  await page.locator("html").evaluate((root) => {
    root.style.fontSize = "200%";
  });
  async function checkHeader() {
    const controls = page.getByRole("banner").getByRole("button");
    for (const control of await controls.all()) {
      const bounds = await control.boundingBox();
      expect(bounds).toBeTruthy();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  }
  await checkHeader();
  await enterAi(page);
  await checkHeader();
});

test("a new account can open the assistant from an empty library", async ({ page, browser }) => {
  const username = `ai-${randomUUID()}`;
  const password = "global-assistant-fixture-password";
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/v1/accounts", {
    headers: { origin },
    data: { username, password },
  });
  expect(created.status()).toBe(201);
  const member = await browser.newContext({ baseURL: origin });
  try {
    const home = await member.newPage();
    await signIn(home, username, password);
    await expect(home.getByText("没有可访问的空间")).toBeVisible();
    await enterAi(home);
    await home.reload();
    await expect(home.getByRole("main").getByRole("heading", { name: "AI 助手" })).toBeVisible();
  } finally {
    await member.close();
  }
});
