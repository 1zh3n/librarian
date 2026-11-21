import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type {
  DeliveryReceipt,
  DocumentSnapshot,
  DocumentSummary,
  Workspace,
} from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

async function createWorkspace(page: Page, name: string, temporary = false) {
  await openFieldWorkspace(page);
  const navigation = page.locator("#workspace-navigation");
  if ((page.viewportSize()?.width ?? 1_280) <= 800) {
    await page.getByRole("button", { name: "展开目录" }).click();
  }
  const chooser = navigation.getByRole("button", { name: /空间/ }).first();
  await chooser.press("Enter");
  await page.getByRole("menuitem", { name: "新建空间" }).click();
  const form = page.getByRole("form", { name: "新建空间" });
  await form.getByRole("textbox", { name: "空间名称" }).fill(name);
  if (temporary) {
    await expect(form.getByRole("button", { name: /空间用途/ })).toBeHidden();
    await form.getByRole("button", { name: "高级选项" }).click();
    await form.getByRole("button", { name: /空间用途/ }).click();
    await page.getByRole("option", { name: "外部文档接收" }).click();
    await form.getByRole("button", { name: /保留方式/ }).click();
    await page.getByRole("option", { name: "临时保存" }).click();
    const expires = await page.evaluate(() => {
      const date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    });
    await form.getByLabel("到期时间").fill(expires);
  }
  await form.getByRole("button", { name: "创建空间" }).click();
  await expect(page).toHaveURL(/\/workspaces\/[^/]+\/manage$/);
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const createdId = new URL(page.url()).pathname.split("/")[2];
  const workspace = workspaces.find((item) => item.id === createdId);
  if (!workspace) throw new Error("Created Workspace is missing from the account");
  return workspace;
}

async function addDocument(page: Page, workspace: string, path: string, markdown: string) {
  const response = await page.request.post(`/api/v1/workspaces/${workspace}/documents`, {
    headers: { origin: new URL(page.url()).origin },
    data: { path, markdown, baseRevision: null },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as DocumentSnapshot;
}

test("returns to the first note in one click from space settings", async ({ page }) => {
  const workspace = await createWorkspace(page, "设置跳转验收");
  const first = await addDocument(page, workspace.id, "01第一篇.md", "第一篇正文\n");
  await addDocument(page, workspace.id, "02第二篇.md", "第二篇正文\n");
  const target = `/workspaces/${workspace.id}/documents/${first.document.id}`;
  await page.goto(target);
  await expect(page.getByRole("article")).toContainText("第一篇正文");
  const firstNote = page.getByRole("row", { name: "01第一篇", exact: true });
  await page.getByRole("button", { name: "空间设置", exact: true }).click();
  await expect(page).toHaveURL(`/workspaces/${workspace.id}/manage`);
  await expect(page.getByRole("tablist", { name: "空间设置" })).toBeVisible();
  await firstNote.click();
  await expect(page).toHaveURL(target, { timeout: 2500 });
  await expect(page.getByRole("article")).toContainText("第一篇正文");
});

async function openTreeSample(page: Page, name: string) {
  const workspace = await createWorkspace(page, name);
  await addDocument(page, workspace.id, "研究/观测/记录.md", "# 记录");
  const reading = await addDocument(page, workspace.id, "在读.md", "# 在读\n\n阅读中的原文。");
  await page.goto(`/workspaces/${workspace.id}/documents/${reading.document.id}`);
  await expect(page.getByRole("article")).toContainText("阅读中的原文");
  return workspace;
}

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Expected a visible element");
  return rect;
}

function capturePointer(page: Page, x: number, y: number, path: string) {
  return page.screenshot({
    path,
    style: `body::after {
      content: ""; position: fixed; z-index: 2147483647; pointer-events: none;
      left: ${x - 6}px; top: ${y - 6}px; width: 12px; height: 12px;
      box-sizing: border-box; border: 2px solid #db2735; border-radius: 50%;
    }`,
  });
}

test("opens directory actions at sidebar controls and inside the panel edges", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTreeSample(page, "目录右键验收");
  const original = page.url();
  const aside = page.locator("#workspace-navigation");
  const chooser = aside.getByRole("button", { name: /空间/ }).first();
  const settings = aside.getByRole("button", { name: "空间设置" });
  const topSearch = page.getByRole("button", { name: "搜索文档" });
  const sidebar = await box(aside);
  const center = async (item: Locator) => {
    const { x, y, width, height } = await box(item);
    return { x: Math.floor(x + width / 2), y: Math.floor(y + height / 2) };
  };
  const hits = [
    { label: "空间切换", ...(await center(chooser)) },
    { label: "空间设置", ...(await center(settings)) },
    { label: "侧栏左上留白", x: sidebar.x + 1, y: sidebar.y + 1 },
    { label: "目录标题", ...(await center(aside.getByText("目录", { exact: true }))) },
    { label: "侧栏最下方", x: 1, y: sidebar.y + sidebar.height - 1 },
    { label: "侧栏右边线", x: sidebar.x + sidebar.width - 1, y: sidebar.y + 65 },
  ];
  const menu = page.getByRole("menu");
  const measurements: {
    label: string;
    x: number;
    y: number;
    bounds: Awaited<ReturnType<typeof box>>;
    viewport: ReturnType<Page["viewportSize"]>;
  }[] = [];
  for (const hit of hits) {
    await test.step(hit.label, async () => {
      await page.mouse.click(hit.x, hit.y, { button: "right" });
      const create = menu.getByRole("menuitem", { name: "新建文档…" });
      await expect(create).toBeVisible({ timeout: 1800 });
      await expect(menu.getByRole("menuitem", { name: /搜索文档/ })).toBeVisible();
      const bounds = await box(menu.locator(".."));
      measurements.push({ ...hit, bounds, viewport: page.viewportSize() });
      const gapX = Math.min(Math.abs(bounds.x - hit.x), Math.abs(bounds.x + bounds.width - hit.x));
      const gapY = Math.min(Math.abs(bounds.y - hit.y), Math.abs(bounds.y + bounds.height - hit.y));
      expect(gapX).toBeLessThanOrEqual(4);
      expect(gapY).toBeLessThanOrEqual(4);
      if (hit.label === "空间切换" || hit.label === "侧栏最下方") {
        await capturePointer(page, hit.x, hit.y, testInfo.outputPath(hit.label + ".png"));
      }
      await create.click();
      const dialog = page.getByRole("dialog", { name: "新建文档" });
      await expect(dialog.getByLabel("目录（可选）")).toHaveValue("");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(original);
    });
  }
  await writeFile(testInfo.outputPath("coordinates.json"), JSON.stringify(measurements, null, 2));
  await topSearch.press("Shift+F10");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await topSearch.click();
  const palette = page.getByRole("dialog", { name: "快速打开与全文搜索" });
  await expect(palette.getByRole("searchbox")).toBeFocused();
  await palette.getByRole("button", { name: "关闭搜索" }).click({ button: "right" });
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(topSearch).toBeFocused();
  await chooser.click();
  await expect(page.getByRole("menuitem", { name: "新建空间" })).toBeVisible();
  await page.keyboard.press("Escape");
  await settings.click();
  await expect(page.getByRole("tablist", { name: "空间设置" })).toBeVisible();
});

test("keeps both paper margins, the divider and the toolbar outside directory actions", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTreeSample(page, "纸面右键边界");
  const main = page.getByRole("main");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  const menu = page.getByRole("menu");
  const row = page.getByRole("row", { name: "在读", exact: true });
  const column = await box(main.locator("[data-reading-measure]"));
  const area = await box(main);
  const y = Math.round(area.y + area.height / 2);
  const margins = [
    { x: Math.floor((area.x + column.x) / 2), y },
    { x: Math.ceil((column.x + column.width + area.x + area.width) / 2), y },
  ];
  const nativeEvents = await page.evaluateHandle(() => {
    const events: boolean[] = [];
    window.addEventListener("contextmenu", (event) => events.push(event.defaultPrevented));
    return events;
  });
  const nativeClick = async (point: { x: number; y: number }) => {
    const before = (await nativeEvents.jsonValue()).length;
    await page.mouse.click(point.x, point.y, { button: "right" });
    expect((await nativeEvents.jsonValue()).slice(before)).toEqual([false]);
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Escape");
  };
  await row.click({ button: "right" });
  await expect(menu).toBeVisible();
  // Crossing from an open directory menu to the page dismisses the old menu.
  for (const point of margins) await nativeClick(point);
  const divider = await box(page.getByRole("separator", { name: "调整空间目录宽度" }));
  await nativeClick({ x: divider.x + divider.width / 2, y });
  await nativeClick({ x: area.x + 40, y: 8 });
  for (const point of margins) {
    await page.getByRole("article").getByText("阅读中的原文。").click();
    await expect(editor).toBeFocused();
    await nativeClick(point);
    if (await editor.isVisible()) await editor.press("Escape");
  }
  await page.getByRole("button", { name: "收起目录" }).click();
  await expect(page.locator("#workspace-navigation")).toBeHidden();
  await nativeClick({ x: 12, y });
  await capturePointer(page, 12, y, info.outputPath("paper-margin.png"));
});

test("a second right click moves the menu directly to the next target", async ({ page }) => {
  await openTreeSample(page, "连续右键验收");
  const row = page.getByRole("row", { name: "观测", exact: true });
  const rect = await box(row);
  const menu = page.getByRole("menu");
  await page.getByRole("row", { name: "记录", exact: true }).click({ button: "right" });
  await expect(menu).toBeVisible();
  const y = Math.floor(rect.y + rect.height / 2);
  for (const fraction of [0.75, 0.2]) {
    const x = Math.floor(rect.x + rect.width * fraction);
    expect(
      await row.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), { x, y }),
    ).toBe(true);
    await page.mouse.click(x, y, { button: "right" });
    await expect(async () => {
      const bounds = await box(menu.locator(".."));
      expect(Math.abs(bounds.x - x)).toBeLessThanOrEqual(4);
      expect(Math.abs(bounds.y - y)).toBeLessThanOrEqual(4);
    }).toPass({ timeout: 1200 });
  }
  await menu.getByRole("menuitem", { name: "新建文档…" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await expect(dialog.getByLabel("目录（可选）")).toHaveValue("研究/观测");
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});

test("uses the toolbar for commands when the directory is unavailable", async ({ page }) => {
  await openFieldWorkspace(page);
  await page.goto("/workspaces/missing-workspace-id");
  await expect(page.getByText("此空间不可用")).toBeVisible();
  await page.mouse.click(300, 12, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "命令", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "命令" }).getByRole("searchbox")).toBeFocused();

  await page.goto("/workspaces/new");
  const form = page.getByRole("form", { name: "新建空间" });
  await expect(form).toBeVisible();
  await page.mouse.click(900, 700, { button: "right" });
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  const name = form.getByRole("textbox", { name: "空间名称" });
  await name.fill("保留名称");
  await name.click({ button: "right" });
  await expect(menu).toHaveCount(0);
  await expect(name).toHaveValue("保留名称");
});

test("preserves the native context menu for a selection, a link and an editor", async ({
  page,
}) => {
  const workspace = await createWorkspace(page, "原生文本菜单验收");
  const note = await addDocument(
    page,
    workspace.id,
    "说明.md",
    "可复制的一句话。\n\n[阅读原文](https://example.org)",
  );
  await page.goto(`/workspaces/${workspace.id}/documents/${note.document.id}`);
  const article = page.getByRole("article");
  const paragraph = article.getByText("可复制的一句话。");
  const cancellations = await page.evaluateHandle(() => {
    const events: boolean[] = [];
    window.addEventListener("contextmenu", (event) => events.push(event.defaultPrevented));
    return events;
  });
  const point = await paragraph.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("可复制的一句话。");
  await page.keyboard.press("Escape");
  await article.getByRole("link", { name: "阅读原文" }).click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+e");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await cancellations.jsonValue()).toEqual([false, false, false]);
});

test("anchors the directory menu to the pointer across the row and flips each viewport edge", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTreeSample(page, "目录菜单位置验收");
  const row = page.getByRole("row", { name: "观测", exact: true });
  const rect = await box(row);
  const menu = page.getByRole("menu", { name: "目录操作" });
  const measurements = [];
  for (const [index, position] of [0.2, 0.8].entries()) {
    const x = Math.floor(rect.x + rect.width * position);
    const y = Math.floor(rect.y + rect.height / 2);
    await page.mouse.click(x, y, { button: "right" });
    await expect(menu).toBeVisible();
    const bounds = await box(menu.locator(".."));
    measurements.push({ x, y, menu: bounds, viewport: page.viewportSize() });
    if (index === 1) {
      await capturePointer(page, x, y, testInfo.outputPath("directory-pointer.png"));
    }
    expect.soft(bounds.x - x).toBeGreaterThanOrEqual(0);
    expect.soft(bounds.x - x).toBeLessThanOrEqual(4);
    expect.soft(bounds.y - y).toBeGreaterThanOrEqual(0);
    expect.soft(bounds.y - y).toBeLessThanOrEqual(4);
    await page.keyboard.press("Escape");
    await expect.soft(row).toBeFocused({ timeout: 500 });
  }
  // Move the real tree into corners outside its normal column.
  for (const [x, y] of [
    [1430, 200],
    [100, 892],
    [1430, 892],
  ] as const) {
    await row.evaluate(
      (node, point) => {
        Object.assign(node.style, {
          position: "fixed",
          left: `${point.x - 60}px`,
          top: `${point.y - 12}px`,
          width: "120px",
          zIndex: "3",
        });
      },
      { x, y },
    );
    await page.mouse.click(x, y, { button: "right" });
    await expect(menu).toBeVisible();
    const bounds = await box(menu.locator(".."));
    measurements.push({ x, y, menu: bounds, viewport: page.viewportSize() });
    const gapX = x > 1000 ? x - bounds.x - bounds.width : bounds.x - x;
    const gapY = y > 800 ? y - bounds.y - bounds.height : bounds.y - y;
    expect(gapX).toBeGreaterThanOrEqual(0);
    expect(gapX).toBeLessThanOrEqual(4);
    expect(gapY).toBeGreaterThanOrEqual(0);
    expect(gapY).toBeLessThanOrEqual(4);
    if (x > 1000 && y > 800) {
      await page.setViewportSize({ width: 1000, height: 650 });
      await expect(async () => {
        const resized = await box(menu.locator(".."));
        expect(resized.x).toBeGreaterThanOrEqual(0);
        expect(resized.y).toBeGreaterThanOrEqual(0);
        expect(resized.x + resized.width).toBeLessThanOrEqual(1000);
        expect(resized.y + resized.height).toBeLessThanOrEqual(650);
      }).toPass({ timeout: 1500 });
    }
    await page.keyboard.press("Escape");
  }
  await testInfo.attach("directory-coordinates", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
});

test("keeps the reading document while creating from a different row or the root background", async ({
  page,
}) => {
  await openTreeSample(page, "目录命令归属验收");
  const original = page.url();
  const note = page.getByRole("row", { name: "记录", exact: true });
  const row = page.getByRole("row", { name: "观测", exact: true });
  const menu = page.getByRole("menu", { name: "目录操作" });
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  const folder = dialog.getByRole("textbox", { name: "目录（可选）" });
  for (const [target, shortcut] of [
    [note, "Shift+F10"],
    [row, "ContextMenu"],
  ] as const) {
    await target.press(shortcut);
    await expect(menu.getByRole("menuitem", { name: "新建文档…" })).toBeFocused();
    const rowRect = await box(target);
    const menuRect = await box(menu.locator(".."));
    expect(Math.abs(rowRect.x - menuRect.x)).toBeLessThanOrEqual(4);
    expect(menuRect.y - rowRect.y - rowRect.height).toBeCloseTo(2);
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /搜索文档/ })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(folder).toHaveValue("研究/观测");
    await page.keyboard.press("Escape");
    await expect(target).toBeFocused();
    await expect(page).toHaveURL(original);
  }
  await row.getByRole("button", { name: /折叠/ }).click();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "新建文档…" }).click();
  await expect(folder).toHaveValue("研究/观测");
  await dialog.getByRole("button", { name: "取消" }).click();
  const bounds = await box(page.locator("#workspace-navigation"));
  await page.mouse.click(bounds.x + 22, bounds.y + bounds.height - 8, { button: "right" });
  await menu.getByRole("menuitem", { name: "新建文档…" }).click({ timeout: 2500 });
  await expect(folder).toHaveValue("");
  await dialog.getByRole("button", { name: "取消" }).click();
  const more = page.getByRole("button", { name: "根目录更多" });
  await more.press("Enter");
  await menu.getByRole("menuitem", { name: "新建文档…" }).press("Enter");
  await expect(folder).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(page.getByRole("button", { name: "新建文档", exact: true })).toHaveCount(0);
});

test.describe("touch directory", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("creates inside a folder with its visible more button and starts writing", async ({
    page,
  }, testInfo) => {
    const workspace = await openTreeSample(page, "触屏目录验收");
    const show = page.getByRole("button", { name: "展开目录" });
    if (await show.isVisible()) await show.tap();
    const more = page.getByRole("button", { name: "观测更多" });
    await more.scrollIntoViewIfNeeded({ timeout: 2500 });
    await expect(more).toHaveCSS("opacity", "1");
    const bounds = await box(more);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("touch-directory.png") });
    await more.tap();
    await page.getByRole("menuitem", { name: "新建文档…" }).tap();
    const dialog = page.getByRole("dialog", { name: "新建文档" });
    await expect(dialog.getByLabel("目录（可选）")).toHaveValue("研究/观测");
    await dialog.getByLabel("文档名称").fill("记录");
    await dialog.getByRole("button", { name: "创建文档" }).tap();
    await expect(dialog.getByRole("alert")).toContainText("同名");
    await expect(dialog.getByLabel("文档名称")).toHaveValue("记录");
    await expect(dialog.getByLabel("目录（可选）")).toHaveValue("研究/观测");
    await dialog.getByLabel("文档名称").fill("夜间记录");
    await dialog.getByRole("button", { name: "创建文档" }).tap();
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await expect(editor).toBeFocused();
    await page.keyboard.insertText("晚风");
    await expect(editor).toContainText("晚风");
    const list = await page.request.get(`/api/v1/workspaces/${workspace.id}/documents`);
    expect(((await list.json()) as DocumentSummary[]).map(({ path }) => path)).toContain(
      "研究/观测/夜间记录.md",
    );
  });
});

test("creates a note directly in a nested directory from the tree menu", async ({ page }) => {
  const workspace = await createWorkspace(page, "右键新建验收");
  const existing = await addDocument(page, workspace.id, "研究/观测/记录.md", "# 记录\n");
  await page.goto(`/workspaces/${workspace.id}/documents/${existing.document.id}`);
  const folder = page
    .getByRole("treegrid", { name: "空间目录" })
    .getByText("观测", { exact: true });
  await folder.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "目录操作" });
  await expect(menu).toBeVisible({ timeout: 2500 });
  await menu.getByRole("menuitem", { name: "新建文档…" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  const directory = dialog.getByRole("textbox", { name: "目录（可选）" });
  await expect(directory).toHaveValue("研究/观测");
  await directory.fill("研究/观测/样本");
  await dialog.getByRole("textbox", { name: "文档名称" }).fill("新观察");
  const cancelColor = await dialog
    .getByRole("button", { name: "取消" })
    .evaluate((button) => getComputedStyle(button).backgroundColor);
  await expect(dialog.getByRole("button", { name: "创建文档" })).not.toHaveCSS(
    "background-color",
    cancelColor,
  );
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  const documents = (await (
    await page.request.get(`/api/v1/workspaces/${workspace.id}/documents`)
  ).json()) as DocumentSummary[];
  expect(documents.some(({ path }) => path === "研究/观测/样本/新观察.md")).toBe(true);
  const note = page.getByRole("row", { name: "新观察", exact: true });
  await expect(note).toBeVisible();
  await note.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "新建文档…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(note).toBeFocused();
});

test("creates and keeps a temporary Workspace at 360 px without changing its address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const workspace = await createWorkspace(page, "浏览器临时空间", true);
  const settings = page.getByRole("form", { name: "空间设置" });
  await settings.getByRole("textbox", { name: "空间名称" }).fill("浏览器长期空间");
  await settings.getByRole("button", { name: /保留方式/ }).click();
  await page.getByRole("option", { name: "长期保存" }).click();
  await settings.getByRole("button", { name: "保存空间设置" }).click();
  await expect(page.getByRole("heading", { name: "浏览器长期空间" })).toBeVisible();
  await page.reload();
  await expect(settings.getByRole("textbox", { name: "空间名称" })).toHaveValue("浏览器长期空间");
  const persisted = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  expect(persisted.find((item) => item.id === workspace.id)).toMatchObject({
    name: "浏览器长期空间",
    retention: "persistent",
    expiresAt: null,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test("renaming a directory keeps the original document deep link", async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Crypto.prototype, "randomUUID"));
  const workspace = await createWorkspace(page, "浏览器路径工作台");
  const document = await addDocument(page, workspace.id, "初始目录/记录.md", "# 路径保留\n");
  const deepLink = `/workspaces/${workspace.id}/documents/${document.document.id}`;
  await page.goto(deepLink);
  await expect(page.getByRole("article")).toContainText("路径保留");
  await page.getByRole("button", { name: "空间设置" }).click();
  const rename = page.getByRole("form", { name: "移动或重命名" });
  await rename.getByRole("textbox", { name: "原路径" }).fill("初始目录");
  await rename.getByRole("textbox", { name: "新路径" }).fill("归档目录");
  await rename.getByRole("button", { name: "保存路径" }).click();
  await expect(rename.getByText("文件或目录已更新")).toBeVisible();
  await page.goto(deepLink);
  await expect(page.getByRole("article")).toContainText("路径保留");
  const snapshot = (await (
    await page.request.get(`/api/v1/documents/${document.document.id}`)
  ).json()) as DocumentSnapshot;
  expect(snapshot.document.path).toBe("归档目录/记录.md");
});

const deliveryZip =
  "UEsDBBQAAAAIACc7dV2GyQopKAAAACUAAAAPAAAAZ3VpZGVzL3N0YXJ0Lm1kU1Z4smvJs76lz3a0Pu2dysWlGP20uf/5lgWxGgWZFak5egV56ZpcAFBLAwQUAAAACAAnO3VdGgJwhz8AAABEAAAAEAAAAGd1aWRlcy9waXhlbC5wbmfrDPBz5+WS4mJgYOD19HAJAtKMIMzBAiS3yvAwASluTxfHkIpbyX/+yzMwMzMxvF/8qB4ozODp6ueyzimhCQBQSwECFAMUAAAACAAnO3VdhskKKSgAAAAlAAAADwAAAAAAAAAAAAAAgAEAAAAAZ3VpZGVzL3N0YXJ0Lm1kUEsBAhQDFAAAAAgAJzt1XRoCcIc/AAAARAAAABAAAAAAAAAAAAAAAIABVQAAAGd1aWRlcy9waXhlbC5wbmdQSwUGAAAAAAIAAgB7AAAAwgAAAAAA";

async function selectDeliveryFile(
  page: Page,
  form: Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const pick = form.getByRole("button", { name: "选择文件", exact: true });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick.click()]);
  await chooser.setFiles(file);
}

test("imports Chinese Markdown and retries the same request after losing the response", async ({
  page,
}) => {
  const workspace = await createWorkspace(page, "浏览器手动导入与重试");
  await page.getByRole("tab", { name: "外部导入" }).click();
  const form = page.getByRole("form", { name: "导入文件" });
  const submit = form.getByRole("button", { name: "确认导入" });
  await expect(submit).toBeDisabled();
  await selectDeliveryFile(page, form, {
    name: "空白.md",
    mimeType: "text/markdown",
    buffer: Buffer.alloc(0),
  });
  await expect(form.getByRole("alert")).toContainText("空文件");
  await selectDeliveryFile(page, form, {
    name: "不支持.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("文本"),
  });
  await expect(form.getByRole("alert")).toContainText("Markdown");
  await expect(submit).toBeDisabled();
  await selectDeliveryFile(page, form, {
    name: "中文手记.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 中文手记\n"),
  });
  const endpoint = `/api/v1/workspaces/${workspace.id}/deliveries`;
  const submissions: unknown[] = [];
  let interrupt: "before commit" | "after commit" | undefined = "after commit";
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(route.request().postDataJSON());
    const mode = interrupt;
    interrupt = undefined;
    if (mode === "before commit") return route.abort();
    const result = await route.fetch();
    expect(result.status()).toBe(201);
    if (mode === "after commit") await route.abort();
    else await route.fulfill({ response: result });
  });
  await submit.click();
  await expect(form.getByRole("alert")).toContainText("重试");
  await form.getByRole("button", { name: "重试导入" }).click();
  await expect(form.getByRole("status")).toContainText("新增 1");
  expect(submissions[0]).toMatchObject({
    manifest: {
      deliveryId: expect.stringMatching(/^manual-[a-f\d-]{36}$/),
      sourceName: "手动导入",
    },
  });
  expect(submissions).toEqual([submissions[0], submissions[0]]);
  const records = (await (await page.request.get(endpoint)).json()) as DeliveryReceipt[];
  expect(records).toHaveLength(1);

  const secondFile = {
    name: "下一批.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 下一批\n"),
  };
  interrupt = "before commit";
  await selectDeliveryFile(page, form, secondFile);
  await submit.click();
  await expect(form.getByRole("alert")).toContainText("重试");
  await page.reload();
  await expect(form.getByRole("status")).toContainText("请重新选择同一批文件");
  const retry = form.getByRole("button", { name: "重试导入" });
  await expect(retry).toBeDisabled();
  interrupt = "after commit";
  await selectDeliveryFile(page, form, secondFile);
  await retry.click();
  await expect(form.getByRole("alert")).toContainText("重试");
  expect(submissions[2]).not.toEqual(submissions[0]);
  expect(submissions[3]).toEqual(submissions[2]);
  await page.reload();
  await expect(form.getByRole("status")).toContainText("导入已完成");
  const completed = (await (await page.request.get(endpoint)).json()) as DeliveryReceipt[];
  expect(completed).toHaveLength(2);
  expect(completed[0]?.deliveryId).not.toBe(completed[1]?.deliveryId);
  const history = page.getByRole("region", { name: "导入记录" });
  await history.getByRole("link", { name: /中文手记\.md/ }).click();
  await expect(page.getByRole("article")).toContainText("中文手记");
});

test("keeps an interrupted source update retryable after CI sends the same manifest", async ({
  page,
}) => {
  const workspace = await createWorkspace(page, "浏览器共享来源更新");
  const base = `/api/v1/workspaces/${workspace.id}`;
  const endpoint = `${base}/deliveries`;
  const origin = new URL(page.url()).origin;
  const manifest = { deliveryId: "shared-docs", sourceName: "共享文档", version: "1" };
  const payload = (version: string, markdown: string) => ({
    manifest: { ...manifest, version },
    files: [{ path: "手记.md", contentBase64: Buffer.from(markdown).toString("base64") }],
  });
  const prepared = await page.request.post(endpoint, {
    headers: { origin },
    data: payload("1", "# 原版\n"),
  });
  expect(prepared.status()).toBe(201);
  const issued = await page.request.post(`${base}/delivery-tokens`, {
    headers: { origin },
    data: { name: "共享来源 CI", deliveryId: manifest.deliveryId },
  });
  expect(issued.status()).toBe(201);
  const { token } = (await issued.json()) as { token: string };

  await page.getByRole("tab", { name: "外部导入" }).click();
  await page.reload();
  const history = page.getByRole("region", { name: "导入记录" });
  await history.getByRole("button", { name: "更新此来源" }).click();
  const form = page.getByRole("form", { name: "导入文件" });
  await form.getByRole("textbox", { name: "版本（可选）" }).fill("2");
  const files = {
    name: "手记.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 浏览器更新\n"),
  };
  await selectDeliveryFile(page, form, files);
  const route = `**${endpoint}`;
  const browserAttempt = payload("2", "# 浏览器更新\n");
  await page.route(route, (request) => {
    if (request.request().method() !== "POST") return request.continue();
    expect(request.request().postDataJSON()).toEqual(browserAttempt);
    return request.abort();
  });
  await form.getByRole("button", { name: "确认导入" }).click();
  await expect(form.getByRole("alert")).toContainText("重试");
  await page.unroute(route);

  const ci = await page.request.post(endpoint, {
    headers: { authorization: `Bearer ${token}` },
    data: payload("2", "# CI 更新\n"),
  });
  expect(ci.status()).toBe(201);
  const ciReceipt = (await ci.json()) as DeliveryReceipt;

  await page.reload();
  await expect(history).toContainText("共享文档 · 2");
  await expect(form.getByRole("status")).toContainText("请重新选择同一批文件");
  const retry = form.getByRole("button", { name: "重试导入" });
  await expect(retry).toBeDisabled();
  await selectDeliveryFile(page, form, files);
  const [retried] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith(endpoint),
    ),
    retry.click(),
  ]);
  expect(retried.request().postDataJSON()).toEqual(browserAttempt);
  expect(retried.status()).toBe(201);
  const browserReceipt = (await retried.json()) as DeliveryReceipt;
  expect(browserReceipt.operationId).not.toBe(ciReceipt.operationId);
  await expect(form.getByRole("status")).toContainText("更新 1");
});

test("uploads a ZIP and keeps its receipt and readable relative attachment", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器投递清单");
  await page.getByRole("tab", { name: "外部导入" }).click();
  const form = page.getByRole("form", { name: "导入文件" });
  await selectDeliveryFile(page, form, {
    name: "oversized.md",
    mimeType: "text/markdown",
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  await expect(form.getByRole("alert")).toContainText("导入文件超过大小限制");
  await expect(form.getByRole("button", { name: "确认导入" })).toBeDisabled();
  await selectDeliveryFile(page, form, {
    name: "delivery.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(deliveryZip, "base64"),
  });
  await expect(form).toContainText("delivery.zip");
  const [response] = await Promise.all([
    page.waitForResponse(
      (entry) => entry.request().method() === "POST" && entry.url().endsWith("/deliveries"),
    ),
    form.getByRole("button", { name: "确认导入" }).click(),
  ]);
  expect(response.status()).toBe(201);
  const receipt = (await response.json()) as DeliveryReceipt;
  expect(receipt.commitId).toMatch(/^[a-f\d]{40}$/u);
  const history = page.getByRole("region", { name: "导入记录" });
  await expect(history).toContainText("新增 2");
  await expect(history).toContainText("guides/pixel.png");
  await page.reload();
  await history.getByRole("link", { name: "guides/start.md" }).click();
  const documents = (await (
    await page.request.get(`/api/v1/workspaces/${workspace.id}/documents`)
  ).json()) as DocumentSummary[];
  expect(documents.map((item) => item.path)).toContain(
    `deliveries/${receipt.deliveryId}/guides/start.md`,
  );
  const image = page.getByRole("article").getByRole("img", { name: "像素" });
  await expect.poll(() => image.evaluate((value: HTMLImageElement) => value.naturalWidth)).toBe(1);
});

test("creates a note from an empty Workspace and starts writing", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器新建文档");
  await page.goto(`/workspaces/${workspace.id}`);
  await expect(page.getByRole("button", { name: /^(?:新建第一篇文档|新建文档)$/u })).toHaveCount(1);
  await page.getByRole("button", { name: "新建第一篇文档" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await dialog.getByRole("textbox", { name: "文档名称" }).fill("我的第一份笔记");
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  await expect(page).toHaveURL(/\/documents\/doc_/u);
  await expect(page.getByRole("row", { name: "我的第一份笔记" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("keeps an unsaved draft when the reader declines to open the new note", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器新建与草稿");
  const current = await addDocument(page, workspace.id, "当前笔记.md", "原文内容\n");
  const currentRoute = `/workspaces/${workspace.id}/documents/${current.document.id}`;
  await page.goto(currentRoute);
  await page
    .getByRole("article")
    .getByText("原文内容")
    .click({ position: { x: 8, y: 16 } });
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  await page.route(`**/api/v1/documents/${current.document.id}`, async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page.keyboard.insertText("保留的本地草稿");
  await page.getByRole("button", { name: "根目录更多" }).click();
  await page.getByRole("menuitem", { name: "新建文档…" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await dialog.getByRole("textbox", { name: "文档名称" }).fill("稍后阅读");
  page.once("dialog", (prompt) => prompt.dismiss());
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByText("已新建「稍后阅读」。可在目录中打开。")).toBeVisible();
  await expect(page).toHaveURL(currentRoute);
  await expect(page.getByRole("article")).toContainText("保留的本地草稿");
  await page.keyboard.press("Alt+e");
  await expect(editor).toContainText("保留的本地草稿");
  const created = page.getByRole("row", { name: "稍后阅读" });
  await expect(created).toBeVisible();
  page.once("dialog", (prompt) => prompt.accept());
  await created.click();
  await expect(page.getByRole("heading", { name: "稍后阅读", level: 1 })).toBeVisible();
  await expect(editor).toHaveCount(0);
});

async function loginViewer(viewer: Page, baseURL: string) {
  await viewer.goto(new URL("/.auth/librarian/login", baseURL).href);
  await viewer.getByLabel("用户名").fill("offline-reader");
  await viewer.getByLabel("密码").fill("offline-reader-test-password");
  const [login] = await Promise.all([
    viewer.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
    ),
    viewer.getByRole("button", { name: "登录" }).click(),
  ]);
  expect(login.status()).toBe(303);
}

test("keeps the entered note and directory when write access changes", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "目录权限变更验收");
  const current = await addDocument(page, workspace.id, "研究/记录.md", "# 记录");
  const membership = `/api/v1/workspaces/${workspace.id}/members/offline-reader`;
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.put(membership, { headers, data: { role: "write" } })).ok()).toBe(
    true,
  );
  const viewer = await browser.newPage();
  try {
    await loginViewer(viewer, page.url());
    await viewer.goto(
      new URL(`/workspaces/${workspace.id}/documents/${current.document.id}`, page.url()).href,
    );
    const row = viewer.getByRole("row", { name: "记录", exact: true });
    await row.press("Shift+F10");
    await viewer.getByRole("menuitem", { name: "新建文档…" }).press("Enter");
    const dialog = viewer.getByRole("dialog", { name: "新建文档" });
    const name = dialog.getByLabel("文档名称");
    await name.fill("今晚的观察");
    expect((await page.request.put(membership, { headers, data: { role: "read" } })).ok()).toBe(
      true,
    );
    await dialog.getByRole("button", { name: "创建文档" }).click();
    await expect(dialog.getByRole("alert")).toContainText("权限");
    await expect(name).toHaveValue("今晚的观察");
    await expect(dialog.getByLabel("目录（可选）")).toHaveValue("研究");
    await expect(dialog.getByRole("button", { name: "创建文档" })).toBeDisabled();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(row).toBeFocused();
  } finally {
    await viewer.close();
  }
});

test("a read-only workspace member can open an import receipt without upload or token controls", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "浏览器只读导入记录");
  const endpoint = `/api/v1/workspaces/${workspace.id}`;
  const origin = new URL(page.url()).origin;
  const membership = await page.request.put(`${endpoint}/members/offline-reader`, {
    headers: { origin },
    data: { role: "read" },
  });
  expect(membership.ok()).toBe(true);
  const delivery = await page.request.post(`${endpoint}/deliveries`, {
    headers: { origin },
    data: {
      manifest: { deliveryId: "from-project", sourceName: "已授权来源" },
      files: [
        { path: "共享回执.md", contentBase64: Buffer.from("# 已授权文档\n").toString("base64") },
      ],
    },
  });
  expect(delivery.status()).toBe(201);
  const viewer = await browser.newPage();
  try {
    await loginViewer(viewer, page.url());
    await viewer.goto(new URL(`/workspaces/${workspace.id}`, page.url()).href);
    await viewer.getByRole("button", { name: "空间设置" }).click();
    const history = viewer.getByRole("region", { name: "导入记录" });
    await expect(history).toContainText("已授权来源");
    await expect(viewer.getByRole("form", { name: "导入文件" })).toHaveCount(0);
    await expect(viewer.getByRole("button", { name: "更新此来源" })).toHaveCount(0);
    await expect(viewer.getByRole("region", { name: "项目自动导入" })).toHaveCount(0);
    await history.getByRole("link", { name: "共享回执.md" }).click();
    await expect(viewer.getByRole("article")).toContainText("已授权文档");
    const directory = viewer.locator("#workspace-navigation");
    await expect(directory.getByRole("button", { name: /更多/ })).toHaveCount(0);
    const row = directory.getByRole("row", { name: "共享回执", exact: true });
    await row.click({ button: "right" });
    const menu = viewer.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /新建文档/ })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: /搜索文档/ }).click({ timeout: 1800 });
    await expect(viewer.getByRole("dialog", { name: "快速打开与全文搜索" })).toBeVisible();
  } finally {
    await viewer.close();
  }
});

test("a share snapshot reads the selected documents anonymously and revokes the same address", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "浏览器共享阅读");
  const start = await addDocument(
    page,
    workspace.id,
    "共享/起点.md",
    "# 起点\n\n[去终点](终点.md) [去私稿](私稿.md)\n\n<script>should-not-render</script>\n",
  );
  await addDocument(page, workspace.id, "共享/终点.md", "# 终点\n");
  await addDocument(page, workspace.id, "共享/私稿.md", "# 私稿\n");
  await page.reload();
  await page.getByRole("tab", { name: "备份与发布" }).click();
  const snapshot = page.getByRole("form", { name: "创建阅读地址" });
  for (const path of ["共享/起点.md", "共享/终点.md"]) {
    await snapshot.getByText(path, { exact: true }).click();
    await expect(snapshot.getByRole("checkbox", { name: path })).toBeChecked();
  }
  await snapshot.getByRole("button", { name: /访问范围/ }).click();
  await page.getByRole("option", { name: "持链接可读" }).click();
  await snapshot.getByRole("button", { name: "创建阅读地址" }).click();
  const address = page.getByRole("link", { name: "打开阅读地址" });
  await expect(address).toBeVisible();
  const href = await address.getAttribute("href");
  if (!href) throw new Error("Snapshot address missing");
  const visitor = await browser.newPage();
  const workspaceRequests: string[] = [];
  visitor.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/workspaces")
      workspaceRequests.push(request.url());
  });
  try {
    await visitor.goto(new URL(href, page.url()).href);
    const article = visitor.getByRole("article");
    await expect(article).toContainText("起点");
    await expect(visitor.getByRole("button", { name: "文档 AI" })).toHaveCount(0);
    await article.click({ button: "right" });
    await expect(visitor.getByRole("menu")).toHaveCount(0);
    expect(workspaceRequests).toHaveLength(0);
    await expect(article.getByRole("link", { name: "去私稿" })).toHaveCount(0);
    await expect(article).not.toContainText("should-not-render");
    await article.getByRole("link", { name: "去终点" }).click();
    await expect(article).toContainText("终点");

    const update = await page.request.put(`/api/v1/documents/${start.document.id}`, {
      headers: { origin: new URL(page.url()).origin },
      data: { markdown: "# 起点已更新\n", baseRevision: start.revision },
    });
    expect(update.ok()).toBe(true);
    await visitor.goto(new URL(href, page.url()).href);
    await expect(article).toContainText("起点已更新");
    await page.getByRole("button", { name: "撤销阅读地址" }).click();
    await expect(page.getByText("阅读地址已撤销")).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole("alert")).toContainText("阅读地址不可用");
  } finally {
    await visitor.close();
  }
});

test("shows a delivery credential once and persists its revocation", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器投递凭证");
  await page.getByRole("tab", { name: "外部导入" }).click();
  const tokens = page.getByRole("region", { name: "项目自动导入" });
  await expect(tokens.getByRole("textbox", { name: "凭证名称" })).toHaveCount(0);
  await tokens.getByRole("button", { name: "项目自动导入", exact: true }).click();
  await tokens.getByRole("textbox", { name: "凭证名称" }).fill("文档 CI");
  const sourceId = "-workspace-docs";
  await tokens.getByRole("textbox", { name: "来源 ID" }).fill(sourceId);
  await tokens.getByRole("button", { name: "签发凭证" }).click();
  const secret = tokens.getByRole("textbox", { name: "新签发的凭证" });
  await expect(secret).toBeVisible();
  await expect(secret).not.toHaveValue("");
  const example = tokens.getByLabel("CLI 示例");
  await expect(example).toContainText("LIBRARIAN_DELIVERY_TOKEN");
  await expect(example).toContainText(`--delivery-id=${sourceId}`);
  const credential = await secret.inputValue();
  await expect(example).not.toContainText(credential);
  const endpoint = `/api/v1/workspaces/${workspace.id}/deliveries`;
  const ci = (version: string, markdown: string, deliveryId = sourceId) =>
    page.request.post(endpoint, {
      headers: { authorization: `Bearer ${credential}` },
      data: {
        manifest: { deliveryId, sourceName: "自动文档", version },
        files: [{ path: "说明.md", contentBase64: Buffer.from(markdown).toString("base64") }],
      },
    });
  const sent = await ci("1", "# 初次送入\n");
  expect(sent.status()).toBe(201);
  expect(await (await ci("1", "# 初次送入\n")).json()).toEqual(await sent.json());
  const updated = await ci("2", "# 项目更新\n");
  expect(updated.status()).toBe(201);
  const updatedReceipt = (await updated.json()) as DeliveryReceipt;
  expect(updatedReceipt.commitId).not.toBe(((await sent.json()) as DeliveryReceipt).commitId);
  expect((await ci("2", "# 无权送入\n", "other-project")).status()).toBe(403);

  await page.reload();
  await tokens.getByRole("button", { name: "项目自动导入", exact: true }).click();
  await expect(secret).toHaveCount(0);
  const token = tokens.getByRole("listitem").filter({ hasText: "文档 CI" });
  await expect(token).toContainText(updatedReceipt.commitId);
  await token.getByRole("button", { name: "撤销凭证" }).click();
  await expect(token).toContainText("已撤销");
  expect((await ci("3", "# 已撤销\n")).status()).toBe(401);
  await page.reload();
  await tokens.getByRole("button", { name: "项目自动导入", exact: true }).click();
  await expect(token).toContainText("已撤销");
  await expect(secret).toHaveCount(0);
});

test("a fixed reading address preserves delivered Markdown and its selected attachment", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "浏览器固定版本");
  const workspaceApi = `/api/v1/workspaces/${workspace.id}`;
  const origin = new URL(page.url()).origin;
  const packaged = await page.request.post(`${workspaceApi}/deliveries`, {
    headers: { origin },
    data: {
      manifest: { deliveryId: "published", sourceName: "固定版本来源" },
      archiveBase64: deliveryZip,
    },
  });
  expect(packaged.ok()).toBe(true);
  const receipt = (await packaged.json()) as { commitId: string };
  const documents = (await (
    await page.request.get(`${workspaceApi}/documents`)
  ).json()) as DocumentSummary[];
  const delivered = documents.find((item) => item.path.endsWith("/guides/start.md"));
  if (!delivered) throw new Error("Missing delivered note");
  await page.reload();
  await page.getByRole("tab", { name: "备份与发布" }).click();
  const form = page.getByRole("form", { name: "创建阅读地址" });
  await form.getByText(delivered.path, { exact: true }).click();
  await expect(form.getByRole("checkbox", { name: delivered.path })).toBeChecked();
  await form.getByRole("button", { name: /地址类型/ }).click();
  await page.getByRole("option", { name: "固定版本" }).click();
  await form.getByRole("button", { name: "版本、有效期与附件" }).click();
  await form.getByRole("textbox", { name: "提交 ID（可选）" }).fill(receipt.commitId);
  await form.getByRole("button", { name: /访问范围/ }).click();
  await page.getByRole("option", { name: "持链接可读" }).click();
  await form
    .getByRole("textbox", { name: /附件路径/ })
    .fill("deliveries/published/guides/pixel.png");
  await form.getByRole("button", { name: "创建阅读地址" }).click();
  const address = page.getByRole("link", { name: "打开阅读地址" });
  await expect(address).toBeVisible();
  const href = await address.getAttribute("href");
  if (!href) throw new Error("Fixed address missing");

  await page.getByRole("tab", { name: "外部导入" }).click();
  const history = page.getByRole("region", { name: "导入记录" });
  await history.getByRole("button", { name: "更新此来源" }).click();
  const upload = page.getByRole("form", { name: "导入文件" });
  await expect(upload.getByRole("textbox", { name: "来源名称" })).toHaveValue("固定版本来源");
  await upload.getByRole("textbox", { name: "版本（可选）" }).fill("2");
  await selectDeliveryFile(page, upload, {
    name: "start.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 新交接清单\n"),
  });
  await upload.getByRole("button", { name: "确认导入" }).click();
  await expect(history).toContainText("固定版本来源 · 2");
  const updated = (await (
    await page.request.get(`${workspaceApi}/deliveries`)
  ).json()) as DeliveryReceipt[];
  expect(updated.map((record) => record.deliveryId)).toEqual(["published", "published"]);
  expect(updated[0]?.changes.map((change) => change.path)).toContain(
    "deliveries/published/start.md",
  );
  const visitor = await browser.newPage();
  try {
    await visitor.goto(new URL(href, page.url()).href);
    const article = visitor.getByRole("article");
    await expect(article).toContainText("交接清单");
    await expect(article).not.toContainText("新交接清单");
    const pixel = article.getByRole("img", { name: "像素" });
    await expect(pixel).toHaveAttribute(
      "src",
      /\/api\/v1\/snapshots\/.+\/assets\/deliveries\/published\/guides\/pixel\.png$/,
    );
    await expect
      .poll(() => pixel.evaluate((value: HTMLImageElement) => value.naturalWidth))
      .toBe(1);
  } finally {
    await visitor.close();
  }
});

test("creates from a keyboard-targeted document after scrolling the tree and saves the first line", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const workspace = await openTreeSample(page, "键盘目录定位");
  for (let i = 0; i < 24; i++) {
    await addDocument(
      page,
      workspace.id,
      `研究/观测/样本${String(i).padStart(2, "0")}.md`,
      "样本笔记",
    );
  }
  await page.reload();
  const target = page.getByRole("row", { name: "样本23", exact: true });
  await target.scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.getByRole("group", { name: "目录内容" }).evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const reading = page.url();
  await target.press("Shift+F10");
  await page.getByRole("menuitem", { name: "新建文档…" }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await expect(dialog.getByLabel("目录（可选）")).toHaveValue("研究/观测");
  await page.keyboard.press("Escape");
  await expect(target).toBeFocused();
  await expect(page).toHaveURL(reading);
  await target.press("Shift+F10");
  await page.getByRole("menuitem", { name: "新建文档…" }).press("Enter");
  await dialog.getByLabel("文档名称").fill("滚动定位后新建");
  await dialog.getByLabel("文档名称").press("Enter");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("继续观测。");
  await page.keyboard.press("Control+s");
  const id = new URL(page.url()).pathname.split("/").pop();
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/documents/${id}`);
      const snapshot = (await response.json()) as DocumentSnapshot;
      return [snapshot.document.path, snapshot.markdown];
    })
    .toEqual(["研究/观测/滚动定位后新建.md", "继续观测。"]);
  const selected = page.getByRole("row", { name: "滚动定位后新建", exact: true });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  const directory = await box(page.getByRole("group", { name: "目录内容" }));
  await expect
    .poll(async () => {
      const row = await box(selected);
      return row.y >= directory.y && row.y + row.height <= directory.y + directory.height + 1;
    })
    .toBe(true);
  await expect(editor).toBeFocused();
  await info.attach("nested-creation", {
    body: JSON.stringify({
      row: await box(selected),
      directory,
      focus: await editor.getAttribute("aria-label"),
      path: "研究/观测/滚动定位后新建.md",
    }),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("nested-editor.png") });
});
