import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSummary } from "../../src/api/client";
import { createNote, openFieldWorkspace } from "./productFixture";

async function fieldDocument(page: Page): Promise<string> {
  const space = await openFieldWorkspace(page);
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

test("preserves phone-size controls and monochrome reading with reduced motion", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 760 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    const route = await fieldDocument(page);
    await page.goto(route);
    const layout = page.getByRole("button", { name: "布局", exact: true });
    const actions = page.getByRole("button", { name: "文档更多" });
    for (const control of [layout, actions]) {
      await expect(control).toBeVisible();
      const size = await control.boundingBox();
      expect(size?.width).toBeGreaterThanOrEqual(24);
      expect(size?.height).toBeGreaterThanOrEqual(24);
    }
    expect(
      await page
        .locator("html")
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).getPropertyValue("--reading-transition")),
        ),
    ).toBe(0);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus-visible").first();
    await expect(focused).toBeInViewport();
    await expect(focused).toHaveCSS("outline-style", "solid");
    await expect(focused).toHaveCSS("outline-width", "2px");

    await layout.tap();
    await page.getByRole("menuitem", { name: "阅读设置" }).tap();
    const settings = page.getByRole("dialog", { name: "阅读设置" });
    await settings.getByText("墨水屏", { exact: true }).tap();
    await expect(settings.getByRole("checkbox", { name: "墨水屏" })).toBeChecked();
    await settings.getByRole("button", { name: "保存设置" }).tap();
    await expect(page.locator("html")).toHaveAttribute("data-eink", "true");
    await expect(page.locator("html")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.getByRole("article")).toHaveCSS("color", "rgb(0, 0, 0)");
    await page.reload();
    await expect(page.getByRole("heading", { name: "河岸清晨", level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-eink", "true");
    const width = await page.locator("html").evaluate((element) => element.scrollWidth);
    expect(width).toBe(360);
  } finally {
    await context.close();
  }
});

test("opens a relative Markdown link through the existing document identity", async ({ page }) => {
  await createNote(page, "野外/LinkSource.md", "[回到河岸](01.md)");
  await page.getByRole("link", { name: "回到河岸" }).click();
  await expect(page.getByRole("heading", { name: "河岸清晨", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/documents\/doc_[a-f0-9]+$/);
});
