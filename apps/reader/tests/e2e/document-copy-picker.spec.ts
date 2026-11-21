import { expect, test, type Page } from "@playwright/test";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

test.use({ viewport: { width: 1440, height: 900 } });

async function setup(page: Page) {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const response = await page.request.post("/api/v1/workspaces", {
    headers,
    data: { name: "编辑部周报" },
  });
  expect(response.status()).toBe(201);
  const space = (await response.json()) as Workspace;
  async function note(path: string, markdown: string) {
    const response = await page.request.post(`/api/v1/workspaces/${space.id}/documents`, {
      headers,
      data: { path, markdown, baseRevision: null },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as DocumentSnapshot;
  }
  const reading = await note("计划.md", "# 编辑计划\n\n留在现场阅读。\n");
  const original = await note("采编/周报.md", "# 周报\r\n\r\n现场纪实。\r\n");
  await note("外地/周报（副本）.md", "别处的副本名称不会占用采编目录。");
  const list = async () =>
    (await (
      await page.request.get(`/api/v1/workspaces/${space.id}/documents`)
    ).json()) as DocumentSnapshot["document"][];
  const copy = async (touch = false) => {
    const row = page.locator(`[data-context-document="${original.documentId}"]`);
    if (touch) await row.getByRole("button", { name: /更多/u }).tap();
    else await row.press("Shift+F10");
    await page.getByRole("menuitem", { name: "复制到…" }).click();
    return page.getByRole("dialog", { name: "复制到", exact: true });
  };
  return { space, headers, reading, original, note, list, copy };
}

test("duplicates the selected row in place, numbers another copy and accepts a custom filename", async ({
  page,
}, info) => {
  const { space, reading, original, list, copy } = await setup(page);
  const address = `/workspaces/${space.id}/documents/${reading.documentId}`;
  await page.goto(address);
  for (const [index, expected] of [
    "周报（副本）.md",
    "周报（副本 2）.md",
    "读者来信.md",
  ].entries()) {
    const dialog = await copy();

    const name = dialog.getByRole("textbox", { name: "副本名称" });
    if (index === 2) await name.fill(expected);
    await expect(name).toHaveValue(expected);
    if (index === 0) {
      await expect(dialog.getByRole("button", { name: "复制到此处" })).toBeEnabled();
      await page.screenshot({ path: info.outputPath("copy-in-source-folder.png") });
    }
    await dialog.getByRole("button", { name: "复制到此处" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(address);
    const copyRow = (await list()).find((row) => row.path === `采编/${expected}`);
    expect(copyRow?.id).toBeTruthy();
    expect(copyRow?.id).not.toBe(original.documentId);
    expect(
      (await (await page.request.get(`/api/v1/documents/${copyRow!.id}`)).json()).markdown,
    ).toBe(original.markdown);
  }
  await expect(page.getByRole("article")).toContainText("留在现场阅读");
});

test.describe("narrow touch destination picker", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("filters matching folders, selects a full path and keeps the source filename", async ({
    page,
  }, info) => {
    const { space, headers, reading, list, copy } = await setup(page);
    for (const folder of ["一组", "二组", "一组/归档", "二组/归档"]) {
      const response = await page.request.post(`/api/v1/workspaces/${space.id}/folders`, {
        headers,
        data: { path: folder },
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto(`/workspaces/${space.id}/documents/${reading.documentId}`);
    await page.getByRole("button", { name: "展开目录" }).tap();
    const dialog = await copy(true);
    await dialog.getByRole("button", { name: /目标目录/u }).tap();
    const search = page.getByRole("searchbox", { name: "搜索目录" });
    await search.tap();
    await search.fill("归档");
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.getByRole("option", { name: "二组/归档", exact: true }).tap({ trial: true });
    await page.screenshot({ path: info.outputPath("search-folders-touch.png") });
    await page.getByRole("option", { name: "二组/归档", exact: true }).tap();
    await expect(dialog.getByRole("button", { name: /目标目录/u })).toContainText("二组/归档");
    await expect(dialog.getByRole("textbox", { name: "副本名称" })).toHaveValue("周报.md");
    await dialog.getByRole("button", { name: "复制到此处" }).tap();
    await expect(dialog).toBeHidden();
    expect((await list()).some((row) => row.path === "二组/归档/周报.md")).toBe(true);
  });
});

test("at 320px and 200% text, the picker accepts a keyboard selection and keeps move-in-place disabled", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const { space, reading, original } = await setup(page);
  await page.goto(`/workspaces/${space.id}/documents/${reading.documentId}`);
  await page.getByRole("button", { name: "展开目录" }).click();
  await page.locator(`[data-context-document="${original.documentId}"]`).press("Shift+F10");
  await page.getByRole("menuitem", { name: "移动到…" }).click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const submit = dialog.getByRole("button", { name: "移动到此处" });
  await expect(submit).toBeDisabled();
  const folder = dialog.getByRole("button", { name: /目标目录/u });
  await folder.press("Enter");
  const search = page.getByRole("searchbox", { name: "搜索目录" });
  await expect(search).toBeFocused();
  await search.fill("根目录");
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(folder).toContainText("根目录");
  await expect(submit).toBeEnabled();
  await expect
    .poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(1);
  const rect = await dialog.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(321);
  await submit.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("copy-folder-picker-320-200.png") });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("copies a folder beside itself without reusing the name of an existing empty folder", async ({
  page,
}) => {
  const { space, headers, reading, original, list } = await setup(page);
  const occupied = await page.request.post(`/api/v1/workspaces/${space.id}/folders`, {
    headers,
    data: { path: "采编（副本）" },
  });
  expect(occupied.ok()).toBe(true);
  await page.goto(`/workspaces/${space.id}/documents/${reading.documentId}`);
  await page.getByRole("row", { name: "采编", exact: true }).press("Shift+F10");
  await page.getByRole("menuitem", { name: "复制到…" }).click();
  const dialog = page.getByRole("dialog", { name: "复制到", exact: true });
  await expect(dialog.getByRole("textbox", { name: "副本名称" })).toHaveValue("采编（副本 2）");
  await dialog.getByRole("button", { name: "复制到此处" }).click();
  await expect(dialog).toBeHidden();
  const copied = (await list()).find((row) => row.path === "采编（副本 2）/周报.md");
  expect(copied?.id).toBeTruthy();
  expect(copied?.id).not.toBe(original.documentId);
});

test("a keyboard menu stays open when the browser scrolls its newly focused row into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const { space, reading, original } = await setup(page);
  await page.goto(`/workspaces/${space.id}/documents/${reading.documentId}`);
  await expect(page.getByRole("article")).toContainText("留在现场阅读");
  await page.getByRole("button", { name: "展开目录" }).click();
  const group = page.getByRole("group", { name: "目录内容" });
  const row = page.locator(`[data-context-document="${original.documentId}"]`);
  await group.evaluate((el) => el.scrollTo({ top: 0 }));
  // Focus and shortcut can happen in the same frame, before the browser delivers its scroll event.
  await row.evaluate(
    (el) =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          (el as HTMLElement).focus();
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "F10",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
      ),
  );
  const menu = page.getByRole("menu", { name: "目录操作" });
  await expect(menu.getByRole("menuitem", { name: "移动到…" })).toBeVisible();
  expect(await group.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await group.evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(menu).toBeHidden();
});
