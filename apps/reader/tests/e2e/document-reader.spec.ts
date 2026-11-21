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

test("groups recent documents and opens an authorized cross-Workspace result", async ({ page }) => {
  await page.goto(await fieldDocument(page));
  await expect(page.getByRole("heading", { name: "河岸清晨", level: 1 })).toBeVisible();
  const search = page.getByRole("button", { name: "搜索文档" });
  await search.click();
  const recent = page.getByRole("group", { name: "最近打开" });
  await expect(recent.getByRole("option", { name: /河岸清晨/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();

  await search.click();
  await page.getByRole("button", { name: "跨空间", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索文档" });
  await input.fill("另一份鸟鸣");
  const match = page.getByRole("option", { name: /另一份鸟鸣/ });
  await expect(match).toContainText("另一空间");
  await match.click();
  await expect(page.getByRole("heading", { name: "另一份鸟鸣", level: 1 })).toBeVisible();
});

test("opens outgoing links and backlinks from the document tools", async ({ page }) => {
  const { document, origin } = await createNote(
    page,
    "reference-source.md",
    "# 引用验收原文\n\n[目标](reference-target.md)\n",
  );
  const workspace = document.document.workspaceId;
  for (const [path, markdown] of [
    ["reference-target.md", "---\ntitle: 被引资料\n---\n\n# 被引资料\n"],
    ["reference-back.md", "---\ntitle: 引用本文的草稿\n---\n\n[回到原文](reference-source.md)\n"],
  ]) {
    const response = await page.request.post(`/api/v1/workspaces/${workspace}/documents`, {
      headers: { origin },
      data: { path, markdown, baseRevision: null },
    });
    expect(response.status()).toBe(201);
  }
  await page.getByRole("button", { name: "引用", exact: true }).click();
  const panel = page.getByRole("region", { name: "文档引用" });
  await expect(panel.getByRole("link", { name: "引用本文的草稿" })).toBeVisible();
  await panel.getByRole("link", { name: "被引资料" }).click();
  await expect(page.getByRole("heading", { name: "被引资料", level: 1 })).toBeVisible();
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

test("opens document AI alongside reading at normal desktop width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(await fieldDocument(page));
  const article = page.getByRole("article");
  await expect(article).toBeVisible();
  const before = await article.boundingBox();
  if (!before) throw new Error("Missing reading canvas");

  await page.getByRole("button", { name: "文档 AI", exact: true }).click();
  const panel = page.getByRole("region", { name: "文档 AI", exact: true });
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const paper = await article.boundingBox();
      const tool = await panel.boundingBox();
      return paper && tool && tool.x >= paper.x + paper.width;
    })
    .toBe(true);
  const after = await article.boundingBox();
  expect(Math.abs((after?.y ?? 0) - before.y)).toBeLessThan(8);
});

for (const width of [390, 1440]) {
  test(`opens the selected tool from deep in a document at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await createNote(
      page,
      `long-tool-anchor-${width}.md`,
      Array.from({ length: 60 }, (_, index) => `## 观察段 ${index}\n\n湿地清晨的记录。\n`).join(
        "\n",
      ),
    );
    const heading = page.getByRole("heading", { name: "观察段 28", exact: true });
    await heading.evaluate((element) => {
      const viewport = element.closest("main");
      if (viewport) viewport.scrollTop += element.getBoundingClientRect().top - 250;
    });
    const before = (await heading.boundingBox())?.y ?? 0;
    const trigger = page.getByRole("button", {
      name: width === 390 ? "文档 AI" : "版本",
      exact: true,
    });
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.press("Enter");
    const panel = page.getByRole("region", {
      name: width === 390 ? "文档 AI" : "版本历史",
      exact: true,
    });
    await expect(panel).toBeInViewport({ ratio: 0.6 });
    if (width === 390) await page.keyboard.press("Escape");
    else await trigger.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect
      .poll(async () => Math.abs(((await heading.boundingBox())?.y ?? 0) - before))
      .toBeLessThan(8);
  });
}

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
      expect(size?.width).toBeGreaterThanOrEqual(44);
      expect(size?.height).toBeGreaterThanOrEqual(44);
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
