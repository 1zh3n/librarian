import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSummary, Workspace } from "../../src/api/client";

async function fieldDocument(page: Page): Promise<string> {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("reader");
  await page.getByLabel("密码").fill("reader-test-password");
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
    ),
    page.getByRole("button", { name: "登录" }).click(),
  ]);
  expect(login.status()).toBe(303);
  const workspaceResponse = await page.request.get("/api/v1/workspaces");
  expect(workspaceResponse.ok()).toBe(true);
  const spaces = (await workspaceResponse.json()) as Workspace[];
  const space = spaces.find((item) => item.name === "田野笔记");
  if (!space) throw new Error("Missing test Space");
  const documents = (await (
    await page.request.get(`/api/v1/workspaces/${space.id}/documents`)
  ).json()) as DocumentSummary[];
  const document = documents.find((item) => item.path === "野外/01.md");
  if (!document) throw new Error("Missing test document");
  return `/workspaces/${space.id}/documents/${document.id}`;
}

test("reloads a document deep link", async ({ page }) => {
  const target = await fieldDocument(page);
  await page.goto(target);
  await expect(page.getByRole("article")).toContainText("湿地观察");
  await page.reload();
  await expect(page.getByRole("heading", { name: "河岸清晨", level: 1 })).toBeVisible();
  await expect(page.getByRole("article")).toContainText("观鸟站");
  await expect(page).toHaveURL(target);
});

test("opens a Chinese search result with the keyboard using the only search entry", async ({
  page,
}) => {
  await page.goto(await fieldDocument(page));
  const search = page.getByRole("button", { name: "搜索文档" });
  await expect(search).toHaveCount(1);
  await search.click();
  const prompt = page.getByRole("searchbox", { name: "搜索文档" });
  await expect(prompt).toBeFocused();
  await prompt.fill("鸟鸣");
  await expect(page.getByRole("option", { name: /林间回声/ })).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(1);
  await prompt.press("ArrowDown");
  await prompt.press("Enter");
  await expect(page.getByRole("heading", { name: "林间回声", level: 1 })).toBeVisible();
});

test("keeps the canvas readable when document contents open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(await fieldDocument(page));
  const article = page.getByRole("article");
  await expect(article).toBeVisible();
  await page.getByRole("button", { name: "收起目录" }).click();
  await page.getByRole("button", { name: "文档目录" }).click();
  await expect(page.getByRole("navigation", { name: "文档目录" })).toBeVisible();
  expect((await article.boundingBox())?.width).toBeGreaterThan(560);
  await page.getByRole("link", { name: "水线" }).click();
  await expect(page.getByRole("heading", { name: "水线" })).toBeInViewport();
});

test("scrolls wide tables and code within the 360 px canvas", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto(await fieldDocument(page));
  const article = page.getByRole("article");
  await expect(article.getByRole("table")).toBeVisible();
  const widths = await article.evaluate((element) => {
    const tableScroll = element.querySelector("table")?.parentElement;
    const pre = element.querySelector("pre");
    return {
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      tableOverflow: (tableScroll?.scrollWidth ?? 0) - (tableScroll?.clientWidth ?? 0),
      codeOverflow: (pre?.scrollWidth ?? 0) - (pre?.clientWidth ?? 0),
    };
  });
  expect(widths.page).toBe(widths.viewport);
  expect(widths.tableOverflow).toBeGreaterThan(0);
  expect(widths.codeOverflow).toBeGreaterThan(0);
});
