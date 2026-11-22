import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

test.use({ viewport: { width: 1440, height: 900 } });

async function setup(page: Page) {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const space = await page.request.post("/api/v1/workspaces", {
    headers,
    data: { name: "口述档案" },
  });
  expect(space.status()).toBe(201);
  const { id } = (await space.json()) as Workspace;
  const write = async (path: string, markdown: string) => {
    const response = await page.request.post(`/api/v1/workspaces/${id}/documents`, {
      headers,
      data: { path, markdown, baseRevision: null },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as DocumentSnapshot;
  };
  const active = await write("手记.md", "# 走访手记\n\n" + "渡口的清晨。\n\n".repeat(90));
  const note = await write("访谈/录音.md", "旧访谈记录");
  const address = `/workspaces/${id}/documents/${active.document.id}`;
  await page.goto(address);
  return { address, note, write };
}

async function remove(page: Page, path: string, { folder = false, touch = false } = {}) {
  const press = (target: Locator) => (touch ? target.tap() : target.click());
  const row = page.locator(`[data-context-path="${path}"]`);
  if (touch) await row.getByRole("button", { name: /更多/u }).tap();
  else await row.click({ button: "right" });
  await press(page.getByRole("menuitem", { name: "删除…" }));
  const dialog = page.getByRole("dialog", { name: folder ? "删除文件夹" : "删除文档" });
  await press(dialog.getByRole("button", { name: "删除", exact: true }));
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
}

async function openDeleted(page: Page) {
  await page.getByRole("button", { name: "根目录更多" }).click();
  await page.getByRole("menuitem", { name: "最近删除", exact: true }).click();
  return page.getByRole("dialog", { name: "最近删除", exact: true });
}

test("lists deleted folders after reload and restores the original documents without interrupting reading", async ({
  page,
}, info) => {
  const { address, note, write } = await setup(page);
  await write("参考/提问清单.md", "确认录音前的提问");
  await page.reload();
  await remove(page, "参考/提问清单.md");
  await remove(page, "访谈", { folder: true });
  await page.reload();
  const article = page.getByRole("article");
  await expect(article).toContainText("走访手记");
  const scroll = await page.getByRole("main").evaluate((el) => {
    el.scrollTop = 400;
    return el.scrollTop;
  });
  expect(scroll).toBeGreaterThan(0);
  const dialog = await openDeleted(page);
  const item = dialog.getByRole("listitem").filter({ hasText: "访谈" });
  await expect(item).toContainText("1 个文件");
  const other = dialog.getByRole("listitem").filter({ hasText: "参考/提问清单.md" });
  await expect(other).toBeVisible();
  await page.screenshot({ path: info.outputPath("recently-deleted-list.png") });
  await other.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(item.getByRole("button", { name: "恢复", exact: true })).toBeFocused();
  await item.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(dialog).toContainText("没有可恢复的项目");
  await dialog.getByRole("button", { name: "关闭", exact: true }).press("Enter");
  await expect(page.locator('[data-context-path="访谈"]')).toBeFocused();
  await expect(page).toHaveURL(address);
  expect(await page.getByRole("main").evaluate((el) => el.scrollTop)).toBe(scroll);
  expect(
    await (await page.request.get(`/api/v1/documents/${note.document.id}`)).json(),
  ).toMatchObject({
    document: { id: note.document.id, path: note.document.path },
    markdown: note.markdown,
  });
  await openDeleted(page);
  await expect(dialog).toContainText("没有可恢复的项目");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "根目录更多" })).toBeFocused();
});

test("offers a retry on list and restore errors and keeps the open draft", async ({ page }) => {
  const { address } = await setup(page);
  await remove(page, "访谈/录音.md");
  await page.route("**/api/v1/documents/*", async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page.getByRole("article").getByText("渡口的清晨。", { exact: true }).first().click();
  await page.keyboard.insertText("未同步的手记");
  await page.route("**/file-actions/deleted", (route) => route.fulfill({ status: 502 }), {
    times: 1,
  });
  const dialog = await openDeleted(page);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  const restore = dialog.getByRole("button", { name: "恢复", exact: true });
  await page.route("**/file-actions/undo", (route) => route.fulfill({ status: 503 }), { times: 1 });
  await restore.click();
  await expect(dialog.getByRole("alert")).toContainText("重试");
  await restore.click();
  await expect(dialog).toContainText("没有可恢复的项目");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).toHaveURL(address);
  await expect(page.getByRole("article")).toContainText("未同步的手记");
});

test.describe("restoring from touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("recovers a conflicting immediate undo into another folder and name, retaining both originals", async ({
    page,
  }, info) => {
    const { address, note, write } = await setup(page);
    await write("归档/索引.md", "档案索引");
    await page.getByRole("button", { name: "展开目录" }).tap();
    await remove(page, "访谈/录音.md", { touch: true });
    const replacement = await write(note.document.path, "新访谈记录");
    await page.getByRole("button", { name: "撤销", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "选择恢复位置" });
    await expect(dialog).toContainText("访谈/录音.md");
    await expect(dialog).toContainText("同名");
    await dialog.getByRole("button", { name: /目标目录/u }).tap();
    await page.getByRole("option", { name: "归档", exact: true }).tap();
    await dialog.getByRole("textbox", { name: /^名称/u }).fill("旧访谈");
    const restore = dialog.getByRole("button", { name: "恢复到此处" });
    expect((await restore.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath("recently-deleted-touch-conflict.png") });
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator("html").evaluate((root) => {
      root.style.fontSize = "200%";
    });
    await restore.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("recently-deleted-320-large-text.png") });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
      const overflows = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*"))
          .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 25)
          .map((el) => [
            el.tagName,
            el.getAttribute("class"),
            Math.round(el.getBoundingClientRect().right),
          ]),
      );
      await info.attach("horizontal-overflow.json", {
        body: JSON.stringify(overflows),
        contentType: "application/json",
      });
    }
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await restore.tap();
    const list = page.getByRole("dialog", { name: "最近删除" });
    await expect(list).toContainText("没有可恢复的项目");
    await list.getByRole("button", { name: "关闭", exact: true }).tap();
    await expect(page).toHaveURL(address);
    await expect(page.locator('[data-context-path="归档/旧访谈.md"]')).toBeFocused();
    for (const [snapshot, path] of [
      [note, "归档/旧访谈.md"],
      [replacement, "访谈/录音.md"],
    ] as const) {
      expect(
        await (await page.request.get(`/api/v1/documents/${snapshot.document.id}`)).json(),
      ).toMatchObject({
        document: { id: snapshot.document.id, path },
        markdown: snapshot.markdown,
      });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});

test("offers a different folder when the deleted document's original parent was removed", async ({
  page,
}) => {
  const { address, note, write } = await setup(page);
  await write("访谈/备忘.md", "删除时确认操作对象");
  await page.reload();
  await remove(page, "访谈/录音.md");
  await remove(page, "访谈", { folder: true });
  const list = await openDeleted(page);
  const entry = list.getByRole("listitem").filter({ hasText: "访谈/录音.md" });
  await entry.getByRole("button", { name: "恢复", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "选择恢复位置" });
  await expect(dialog).toContainText("原文件夹已不存在");
  await dialog.getByRole("button", { name: /目标目录/u }).click();
  await page.getByRole("option", { name: "根目录", exact: true }).click();
  await dialog.getByRole("button", { name: "恢复到此处" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("已恢复「录音.md」");
  await list.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator('[data-context-path="录音.md"]')).toBeFocused();
  await expect(page).toHaveURL(address);
  expect(
    await (await page.request.get(`/api/v1/documents/${note.document.id}`)).json(),
  ).toMatchObject({ document: { id: note.document.id, path: "录音.md" }, markdown: note.markdown });
});

test("the root menu tooltip stays reachable and leaves workspace settings clickable after Escape", async ({
  page,
}) => {
  await setup(page);
  await expect(page.getByRole("article")).toContainText("走访手记");
  const rootMenu = page.getByRole("button", { name: "根目录更多", exact: true });
  const settings = page.getByRole("button", { name: "空间设置", exact: true });
  const tip = page.getByRole("tooltip").filter({ hasText: "根目录更多" });
  await openDeleted(page);
  await page.keyboard.press("Escape");
  await expect(rootMenu).toBeFocused();
  await expect(tip).toBeVisible();
  await expect
    .poll(() =>
      settings.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        );
      }),
    )
    .toBe(true);
  await settings.click();
  await expect(page.getByRole("form", { name: "空间设置" })).toBeVisible();
  await rootMenu.hover();
  await expect(tip).toBeVisible();
  await tip.hover();
  await expect(tip).toBeVisible();
});
