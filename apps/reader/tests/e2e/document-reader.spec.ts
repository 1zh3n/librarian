import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSummary } from "../../src/api/client";
import {
  closeDocumentTool,
  createNote,
  openDocumentTool,
  openFieldWorkspace,
} from "./productFixture";

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

test("opens one accessible document tool pane and keeps AI input when switching tabs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const field = await openFieldWorkspace(page);
  const notes = (await (
    await page.request.get(`/api/v1/workspaces/${field.id}/documents`)
  ).json()) as DocumentSummary[];
  const note = notes.find(({ path }) => path === "野外/02.md");
  if (!note) throw new Error("Missing outline fixture");
  await page.goto(`/workspaces/${field.id}/documents/${note.id}`);
  const open = page.getByRole("button", { name: "打开文档辅助区" });
  const tabs = page.getByRole("tablist", { name: "文档工具" });
  await expect(open).toBeVisible();
  await expect(tabs).toHaveCount(0);
  await open.press("Enter");
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  const outline = tabs.getByRole("tab", { name: "提纲", exact: true });
  await expect(outline).toHaveAttribute("aria-selected", "true");
  await expect(outline).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const ai = tabs.getByRole("tab", { name: "AI", exact: true });
  await expect(ai).toHaveAttribute("aria-selected", "true");
  const prompt = page.getByRole("textbox", { name: "提示词" });
  await prompt.fill("保留的草稿提示词");
  await tabs.getByRole("tab", { name: "版本", exact: true }).click();
  await ai.click();
  await expect(prompt).toHaveValue("保留的草稿提示词");
  await page.getByRole("button", { name: "收起文档辅助区" }).click();
  await expect(tabs).toHaveCount(0);
  await expect(open).toBeFocused();
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
  await openDocumentTool(page, "引用");
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
  await openDocumentTool(page, "文档目录");
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

  await openDocumentTool(page, "AI");
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
      name: "打开文档辅助区",
      exact: true,
    });
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.press("Enter");
    if (width === 1440) await openDocumentTool(page, "版本");
    const panel = page.getByRole("region", {
      name: width === 390 ? "文档 AI" : "版本历史",
      exact: true,
    });
    await expect(panel).toBeInViewport({ ratio: 0.6 });
    if (width === 390) await page.keyboard.press("Escape");
    else await closeDocumentTool(page);
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

    await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).tap();
    const settings = page.getByRole("dialog", { name: "应用设置" });
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

test("opens phone tools beside the current passage and follows a contents link into reading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createNote(
    page,
    "InlineToolPassage.md",
    Array.from(
      { length: 40 },
      (_, n) => `## 河道调查第 ${n} 站\n\n沿岸核对水位，记录当地植被和地形。\n`,
    ).join("\n"),
  );
  const passage = page.getByRole("heading", { name: "河道调查第 20 站", exact: true });
  await passage.evaluate((el) => {
    const viewport = el.closest("main")!;
    viewport.scrollTop += el.getBoundingClientRect().top - 190;
  });
  const before = (await passage.boundingBox())!.y;
  await openDocumentTool(page, "AI");
  const pane = page.getByRole("region", { name: "文档辅助区", exact: true });
  await expect(pane).toBeInViewport({ ratio: 1 });
  await expect(passage).toBeInViewport({ ratio: 1 });
  expect((await passage.boundingBox())!.y).toBeGreaterThanOrEqual(
    (await pane.boundingBox())!.y + (await pane.boundingBox())!.height,
  );
  await openDocumentTool(page, "引用");
  await expect(pane).toBeInViewport({ ratio: 1 });
  await closeDocumentTool(page);
  await expect
    .poll(async () => Math.abs((await passage.boundingBox())!.y - before))
    .toBeLessThan(8);
  await openDocumentTool(page, "文档目录");
  const contents = page.getByRole("navigation", { name: "文档目录" });
  await contents.getByRole("link", { name: "河道调查第 35 站", exact: true }).press("Enter");
  const target = page.getByRole("heading", { name: "河道调查第 35 站", exact: true });
  await expect(target).toBeInViewport({ ratio: 1 });
  await expect(target).toBeFocused();
  await expect(contents).toBeHidden();
});

test("balances a two-line Chinese document title on the desktop reading column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = "从河口到山麓：沿溪调查的记事与方法";
  await createNote(
    page,
    "BalancedFieldTitle.md",
    `---\ntitle: ${title}\n---\n\n清晨从河口出发。\n`,
  );
  const widths = await page.getByRole("heading", { level: 1, name: title }).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return Array.from(range.getClientRects(), (rect) => rect.width);
  });
  expect(widths).toHaveLength(2);
  expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.55);
});

test("offers the whole desktop outline canvas for writing and fits short reference lists", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "WritableOutlineCanvas.md", "# 观察记录\n\n雨后沿岸测量。\n");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "添加提纲" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 提纲" });
  await expect(editor).toBeFocused();
  const pane = page.getByRole("region", { name: "文档辅助区" });
  const box = (await pane.boundingBox())!;
  await page.getByRole("tab", { name: "提纲", exact: true }).focus();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 45);
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("水位测点");
  await openDocumentTool(page, "引用");
  await expect(page.getByRole("heading", { name: "引用本篇" })).toBeVisible();
  expect((await pane.boundingBox())!.height).toBeLessThan(300);
  await openDocumentTool(page, "提纲");
  await expect(editor).toContainText("水位测点");
});

test("opens a long desktop contents list at the current section and returns keyboard focus to the chosen heading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(
    page,
    "ContentsCurrentSection.md",
    Array.from(
      { length: 64 },
      (_, n) => `## 测量站 ${n}\n\n${"沿途补记水温与风向。".repeat(12)}\n`,
    ).join("\n"),
  );
  const current = page.getByRole("heading", { name: "测量站 44", exact: true });
  await current.evaluate((el) => {
    const main = el.closest("main")!;
    main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 41;
  });
  await openDocumentTool(page, "文档目录");
  const nav = page.getByRole("navigation", { name: "文档目录" });
  const selected = nav.getByRole("link", { name: "测量站 44", exact: true });
  await expect(selected).toHaveAttribute("aria-current", "location");
  await expect(selected).toBeInViewport({ ratio: 1 });
  const chosen = nav.getByRole("link", { name: "测量站 48", exact: true });
  await chosen.press("Enter");
  await expect(page.getByRole("heading", { name: "测量站 48", exact: true })).toBeFocused();
  await expect(chosen).toHaveAttribute("aria-current", "location");
});

test("distinguishes clickable command labels from editable text with a desktop pointer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(await fieldDocument(page));
  const row = page.getByRole("treegrid").getByText("河岸清晨", { exact: true });
  await row.hover();
  await expect.soft(row).toHaveCSS("cursor", "pointer");
  const layout = page.getByRole("button", { name: "布局", exact: true });
  await layout.click();
  const preset = page.getByRole("menu").getByText("写作布局", { exact: true });
  await preset.hover();
  await expect.soft(preset).toHaveCSS("cursor", "pointer");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article").locator("p").first()).toHaveCSS("cursor", "text");
});
