import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { closeDocumentTool, createNote, openDocumentTool } from "./productFixture";

const title = "从河口到山麓：沿溪调查的记事与方法";
const paragraphs = [
  "晨雾还没有散去，我们在河口的旧石桥下汇合。上游几天前下过雨，水线比上一次高出两掌，沿岸的细沙留下了一圈深色的痕迹。",
  "站在山麓的背风面，声音比在河床里清楚。队员分头标记水位、朝向和植被，再回到桥头核对各自的记录。",
  "木桩边的水草微微摆动，阳光从树叶的空隙照下来。为了在下次访问时找到同一测点，我们拍下河道转折与两侧山坡的位置。",
];
const stations = ["石桥", "河湾", "北岸", "山麓"];
const fieldNotes = [
  "> 先记录水面，再回头寻找离岸的痕迹。",
  "[参阅河岸记录](01.md)",
  `| 测点 | 河道 |\n| --- | --- |\n| 桥头 | ${"上游水位记录".repeat(24)} |`,
  `\`\`\`text\n${"水位标记 · ".repeat(30)}\n\`\`\``,
].join("\n\n");
const markdown =
  [
    `---\ntitle: ${title}\n---`,
    paragraphs[0],
    ...Array.from({ length: 18 }, (_, i) =>
      [
        `## 第${i + 1}站 · ${stations[i % 4]}`,
        paragraphs[(i + 1) % 3],
        paragraphs[(i + 2) % 3],
        ...(i === 0 ? [fieldNotes] : []),
      ].join("\n\n"),
    ),
  ].join("\n\n") + "\n";

async function report(name: string, values: unknown) {
  await writeFile(test.info().outputPath(name + ".json"), JSON.stringify(values, null, 2) + "\n");
}

async function shot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: test.info().outputPath(name + ".png") });
}

async function openLongNote(page: Page, name: string) {
  const note = await createNote(page, `野外/走查-${name}.md`, markdown);
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return note;
}

async function position(block: Locator) {
  return block.evaluate((el) => el.getBoundingClientRect().top);
}

async function placeStation(page: Page) {
  const station = page.getByRole("heading", { name: "第11站 · 北岸", exact: true });
  await station.evaluate((el) => {
    const main = el.closest("main")!;
    main.scrollTop += el.getBoundingClientRect().top - 210;
  });
  await expect(station).toBeInViewport({ ratio: 1 });
  return station;
}

for (const width of [1440, 390, 360, 320]) {
  test.describe(`Chinese field notes at ${width}px`, () => {
    test.use({
      viewport: { width, height: width === 1440 ? 900 : 844 },
      isMobile: width !== 1440,
      hasTouch: width !== 1440,
    });

    test("aligns the title and lead and scrolls a wide table and code locally", async ({
      page,
    }) => {
      await openLongNote(page, `reflow-${width}`);
      const article = page.getByRole("article");
      const lead = article.locator("p").first();
      const heading = page.getByRole("heading", { name: title, level: 1 });
      const titleBox = (await heading.boundingBox())!;
      const leadBox = (await lead.boundingBox())!;
      const titleLines = await heading.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return Array.from(range.getClientRects(), (rect) => rect.width);
      });
      await shot(page, `reading-${width}`);
      await expect(lead).toBeInViewport({ ratio: 1 });
      expect(Math.abs(titleBox.x - leadBox.x)).toBeLessThanOrEqual(1);
      const layout = await article.evaluate((el) => {
        const main = el.closest("main")!;
        const table = el.querySelector("table")!.parentElement!;
        const code = el.querySelector("pre")!;
        const localScroll = (node: HTMLElement) => {
          node.scrollLeft = node.scrollWidth;
          return { width: node.clientWidth, total: node.scrollWidth, end: node.scrollLeft };
        };
        return {
          width: innerWidth,
          page: document.documentElement.scrollWidth,
          mainWidth: main.clientWidth,
          mainScrollWidth: main.scrollWidth,
          articleWidth: el.clientWidth,
          bodyFont: getComputedStyle(el).fontSize,
          lineHeight: getComputedStyle(el).lineHeight,
          table: localScroll(table),
          code: localScroll(code),
          pageLeft: scrollX,
          mainLeft: main.scrollLeft,
        };
      });
      await report(`reflow-${width}`, { titleBox, titleLines, leadBox, ...layout });
      expect(layout.page).toBe(width);
      expect(layout.mainScrollWidth).toBe(layout.mainWidth);
      expect(layout.pageLeft).toBe(0);
      expect(layout.mainLeft).toBe(0);
      for (const local of [layout.table, layout.code]) {
        expect(local.end).toBeGreaterThan(0);
        expect(Math.abs(local.end - (local.total - local.width))).toBeLessThanOrEqual(1);
      }
      if (width === 320) {
        await article.getByRole("table").locator("..").scrollIntoViewIfNeeded();
        await shot(page, "table-320");
      }
    });
  });
}

test("200% browser text size doubles the actual reading font without horizontal overflow", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLongNote(page, "text-size");
  const article = page.getByRole("article");
  const measure = () =>
    article.evaluate((el) => ({
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      body: parseFloat(getComputedStyle(el).fontSize),
      paragraphHeight: el.querySelector("p")!.getBoundingClientRect().height,
      pageWidth: document.documentElement.scrollWidth,
      mainWidth: el.closest("main")!.clientWidth,
      mainScrollWidth: el.closest("main")!.scrollWidth,
    }));
  const before = await measure();
  const protocol = await context.newCDPSession(page);
  await protocol.send("Page.setFontSizes", { fontSizes: { standard: before.root * 2 } });
  await shot(page, "text-200");
  const after = await measure();
  await report("text-200", { before, after });
  expect(after.root).toBe(before.root * 2);
  expect(after.body).toBe(before.body * 2);
  expect(after.paragraphHeight).toBeGreaterThan(before.paragraphHeight);
  expect(after.pageWidth).toBe(390);
  expect(after.mainScrollWidth).toBe(after.mainWidth);
});

for (const width of [1440, 390]) {
  test.describe(`Long document interactions at ${width}px`, () => {
    test.use({
      viewport: { width, height: width === 1440 ? 900 : 844 },
      hasTouch: width === 390,
      isMobile: width === 390,
    });

    test("returns from editing, focus and an outline switch to the selected passage", async ({
      page,
    }) => {
      const { apiUrl, origin } = await openLongNote(page, `passage-${width}`);
      const seeded = await page.request.put(`${apiUrl}/outline`, {
        headers: { origin },
        data: { markdown: "- 出发和测量\n", baseRevision: null },
      });
      expect(seeded.ok()).toBe(true);
      await page.reload();
      const article = page.getByRole("article");
      const body = page.getByRole("textbox", { name: "Markdown 正文" });
      await article
        .locator("p")
        .first()
        .click({ position: { x: 8, y: 16 } });
      await expect(body).toBeFocused();
      await shot(page, `first-edit-${width}`);
      await body.press("Escape");
      const station = await placeStation(page);
      const paragraph = station.locator("~ p").first();
      const original = await position(station);
      const lines = await paragraph.boundingBox();
      await shot(page, `deep-reading-${width}`);
      await paragraph.click({ position: { x: 8, y: 16 } });
      await expect(body).toBeFocused();
      expect(await page.evaluate(() => getSelection()?.anchorNode?.textContent)).toContain(
        "木桩边",
      );
      await shot(page, `deep-edit-${width}`);
      await body.press("Escape");
      await expect(article).toBeFocused();
      const afterEdit = await position(station);
      await page.keyboard.press("f");
      await expect(page.getByText("专注阅读 · Esc 退出")).toBeVisible();
      const inFocus = await position(station);
      const focusLines = await paragraph.boundingBox();
      await page.keyboard.press("Escape");
      const afterFocus = await position(station);
      const selection = await paragraph.evaluate((el) => {
        const text = el.firstChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 10);
        const selected = window.getSelection()!;
        selected.removeAllRanges();
        selected.addRange(range);
        return selected.toString();
      });
      expect(selection).toBe("木桩边的水草微微摆动");
      await shot(page, `selected-${width}`);
      await openDocumentTool(page, "提纲");
      const outline = page.getByRole("textbox", { name: "Markdown 提纲" });
      await outline.press("Control+End");
      await page.keyboard.insertText("- 回访北岸");
      await openDocumentTool(page, "引用");
      await openDocumentTool(page, "提纲");
      await expect(outline).toContainText("回访北岸");
      const pane = page.getByRole("region", { name: "文档辅助区", exact: true });
      await expect(pane).toBeInViewport();
      await expect(paragraph).toBeInViewport();
      const withTool = await position(paragraph);
      const paneBox = (await pane.boundingBox())!;
      await shot(page, `outline-${width}`);
      await closeDocumentTool(page);
      const afterClose = await position(station);
      await expect(page.getByRole("button", { name: "打开文档辅助区" })).toBeFocused();
      await report(`passage-${width}`, {
        original,
        afterEdit,
        inFocus,
        afterFocus,
        selection,
        withTool,
        paneBox,
        afterClose,
        lines,
        focusLines,
      });
      for (const top of [afterEdit, inFocus, afterFocus, afterClose]) {
        expect(Math.abs(top - original)).toBeLessThan(8);
      }
      expect(focusLines?.width).toBe(lines?.width);
      expect(focusLines?.height).toBe(lines?.height);
      if (width === 390) expect(withTool).toBeGreaterThanOrEqual(paneBox.y + paneBox.height);
      const saved = (await (await page.request.get(apiUrl)).json()) as { markdown: string };
      expect(saved.markdown).toBe(markdown);
    });
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`monochrome ${scheme} retains link and keyboard focus cues with reduced motion`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openLongNote(page, `gray-${scheme}`);
    const firstParagraph = page.getByRole("article").locator("p").first();
    await expect(page.locator("html")).toHaveAttribute("data-eink", "false");
    await expect(firstParagraph).toHaveCSS("transition-duration", "0s");
    if (scheme === "dark") await shot(page, "reading-dark");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "应用设置" });
    await settings.getByRole("checkbox", { name: "墨水屏" }).press("Space");
    await expect(page.locator("html")).toHaveAttribute("data-eink", "true");
    await settings.getByRole("button", { name: "关闭应用设置" }).click();
    await expect(settings).toBeHidden();
    const article = page.getByRole("article");
    await article.focus();
    await page.keyboard.press("Tab");
    const link = article.getByRole("link", { name: "参阅河岸记录" });
    await expect(link).toBeFocused();
    await link.scrollIntoViewIfNeeded();
    const styles = await link.evaluate((el) => ({
      text: getComputedStyle(el).color,
      paper: getComputedStyle(document.documentElement).backgroundColor,
      underline: getComputedStyle(el).textDecorationLine,
      outline: getComputedStyle(el).outlineStyle,
      outlineWidth: getComputedStyle(el).outlineWidth,
      motion: parseFloat(getComputedStyle(el).getPropertyValue("--reading-transition")),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    await report(`gray-${scheme}`, styles);
    await shot(page, `gray-${scheme}`);
    expect(styles).toMatchObject({
      text: scheme === "dark" ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
      paper: scheme === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
      underline: "underline",
      outline: "solid",
      outlineWidth: "2px",
      reducedMotion: true,
      motion: 0,
    });
  });
}

test("typing on the first editor frame keeps the reading anchor when search takes focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLongNote(page, "frame-input");
  const station = await placeStation(page);
  const original = await position(station);
  const passage = station.locator("~ p").first();
  const marker = "核对测点";
  // Insert through the focused contenteditable during its first layout pass.
  // Waiting for a Playwright keyboard round trip can miss the affected frame.
  await page.getByRole("main").evaluate((main, text) => {
    const observer = new MutationObserver(() => {
      if (!main.querySelector('[contenteditable="true"][aria-label="Markdown 正文"]')) return;
      observer.disconnect();
      requestAnimationFrame(() => document.execCommand("insertText", false, text));
    });
    observer.observe(main, { childList: true, subtree: true });
  }, marker);
  await passage.click({ position: { x: 8, y: 16 } });
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toContainText(marker);
  await page.getByRole("button", { name: "搜索文档" }).click();
  await page.getByRole("searchbox").press("Escape");
  await expect(passage).toContainText(marker);
  expect(Math.abs((await position(station)) - original)).toBeLessThan(8);
});

test("no-result search and settings return to the deep passage with its unconfirmed edit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { apiUrl } = await openLongNote(page, "draft");
  const station = await placeStation(page);
  const paragraph = station.locator("~ p").first();
  const marker = "本地待核对";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${apiUrl}`, async (route) => {
    if (route.request().method() === "PUT") await pending;
    await route.continue();
  });
  try {
    const original = await position(station);
    await paragraph.click({ position: { x: 8, y: 16 } });
    const body = page.getByRole("textbox", { name: "Markdown 正文" });
    await body.press("Home");
    await page.keyboard.insertText(marker);
    const search = page.getByRole("button", { name: "搜索文档" });
    await search.click();
    const input = page.getByRole("searchbox");
    await input.fill("没有这份北岸校对稿");
    await expect(page.getByText("未找到文档")).toBeVisible();
    await shot(page, "draft-search");
    await input.press("Escape");
    await expect(search).toBeFocused();
    await expect(paragraph).toContainText(marker);
    const afterSearch = await position(station);
    const article = page.getByRole("article");
    await article.evaluate((el) => el.focus({ preventScroll: true }));
    await page.keyboard.press("Control+k");
    await input.fill("设置");
    await page.getByRole("option", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "应用设置" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(article).toBeFocused();
    await expect(paragraph).toContainText(marker);
    const afterSettings = await position(station);
    const saved = (await (await page.request.get(apiUrl)).json()) as { markdown: string };
    expect(saved.markdown).toBe(markdown);
    await report("draft-return", {
      original,
      afterSearch,
      afterSettings,
      focus: await page.evaluate(() => document.activeElement?.tagName),
      unsaved: marker,
    });
    await shot(page, "draft-return");
    expect(Math.abs(afterSearch - original)).toBeLessThan(8);
    expect(Math.abs(afterSettings - original)).toBeLessThan(8);
  } finally {
    release();
  }
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(apiUrl)).json()) as { markdown: string }).markdown,
    )
    .toContain(marker);
  await page.getByRole("article").press("Alt+e");
  const resumed = page.getByRole("textbox", { name: "Markdown 正文" });
  await resumed.press("Control+z");
  await resumed.press("Escape");
  await expect(paragraph).not.toContainText(marker);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(apiUrl)).json()) as { markdown: string }).markdown,
    )
    .toBe(markdown);
});

test("a read-only member opens the current note and its older saved release offline", async ({
  page,
  browser,
}) => {
  const {
    document: original,
    origin,
    apiUrl,
    pathToNote,
  } = await createNote(page, "野外/只读版本走查.md", markdown, "另一空间");
  const release = await page.request.post(
    `/api/v1/workspaces/${original.document.workspaceId}/snapshots`,
    {
      headers: { origin },
      data: { kind: "release", audience: "members", documentIds: [original.document.id] },
    },
  );
  expect(release.status()).toBe(201);
  const address = (await release.json()) as { id: string; url: string };
  const update = "本次回访补入的校勘";
  const fresh = await page.request.put(apiUrl, {
    headers: { origin },
    data: { markdown: markdown.replace(paragraphs[0]!, update), baseRevision: original.revision },
  });
  expect(fresh.ok()).toBe(true);
  const visitor = await browser.newContext({
    baseURL: origin,
    viewport: { width: 360, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const login = await visitor.request.post("/.auth/librarian/login", {
      headers: { origin },
      form: { username: "offline-reader", password: "offline-reader-test-password" },
      maxRedirects: 0,
    });
    expect(login.status()).toBe(303);
    const member = await visitor.newPage();
    await member.goto(pathToNote);
    const article = member.getByRole("article");
    await expect(article).toContainText(update);
    await article.getByText(update, { exact: true }).tap();
    await article.press("Alt+e");
    await expect(member.getByRole("textbox", { name: "Markdown 正文" })).toHaveCount(0);
    await member.getByRole("button", { name: "文档更多" }).tap();
    const menu = member.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "文档目录" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /完整源码|添加提纲/ })).toHaveCount(0);
    await shot(member, "readonly");
    await member.goto(address.url);
    await expect(article.locator("p").first()).toHaveText(paragraphs[0]!);
    await expect(article).not.toContainText(update);
    await member.getByRole("button", { name: "保存离线副本" }).tap();
    await expect(member.getByText("已保存离线副本", { exact: true })).toBeVisible();
    await member.close();
    const offline = await visitor.newPage();
    const blocked = new Set<string>();
    await visitor.route("**/*", async (route) => {
      if (route.request().serviceWorker()) {
        blocked.add(new URL(route.request().url()).pathname);
        await route.abort("internetdisconnected");
      } else await route.fallback();
    });
    await visitor.setOffline(true);
    await offline.goto(address.url);
    await expect(offline.getByText("正在读取离线副本")).toBeVisible();
    await expect(offline.getByRole("article").locator("p").first()).toHaveText(paragraphs[0]!);
    await expect(offline.getByRole("article")).not.toContainText(update);
    await expect(offline.getByRole("textbox")).toHaveCount(0);
    const apiBlocked = blocked.has(`/api/v1/snapshots/${address.id}`);
    expect(apiBlocked).toBe(true);
    const width = await offline.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBe(360);
    await shot(offline, "offline");
    await report("snapshot", {
      currentLead: update,
      releaseLead: paragraphs[0],
      blockedSnapshotRequest: apiBlocked,
      width,
    });
  } finally {
    await visitor.close();
  }
});
