import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

const markdown = "---\ntitle: 雨季观察\n---\n\n## 河岸\n\n记录初夏的水位。\n";
async function sample(page: Page, path = "研究/旧档.md") {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const response = await page.request.post("/api/v1/workspaces", {
    headers,
    data: { name: "重命名验收" },
  });
  expect(response.status()).toBe(201);
  const workspace = (await response.json()) as Workspace;
  const add = async (path: string, body: string) => {
    const res = await page.request.post(`/api/v1/workspaces/${workspace.id}/documents`, {
      headers,
      data: { path, markdown: body, baseRevision: null },
    });
    expect(res.status()).toBe(201);
    return (await res.json()) as DocumentSnapshot;
  };
  const note = await add(path, markdown);
  const other = await add("研究/已占用.md", "继续读这篇。");
  const apiUrl = `/api/v1/documents/${note.document.id}`;
  const outline = await page.request.put(`${apiUrl}/outline`, {
    headers,
    data: { markdown: "- 雨前\n", baseRevision: null },
  });
  expect(outline.ok()).toBe(true);
  return {
    workspace,
    note,
    apiUrl,
    outline: await outline.json(),
    headers,
    address: `/workspaces/${workspace.id}/documents/${note.document.id}`,
    otherAddress: `/workspaces/${workspace.id}/documents/${other.document.id}`,
  };
}

test("renames the keyboard-targeted document in place, retaining title, stable link and outline", async ({
  page,
}, info) => {
  const { note, apiUrl, outline, address, otherAddress } = await sample(page);
  await page.goto(otherAddress);
  const row = page.getByRole("row", { name: /雨季观察/ });
  await row.press("Shift+F10");
  const rename = page.getByRole("menuitem", { name: "重命名…" });
  await expect(rename).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /搜索文档/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rename).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "重命名文档" });
  const name = dialog.getByLabel("文件名");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("旧档");
  const submit = dialog.getByRole("button", { name: "保存文件名" });
  await expect(submit).toBeDisabled();
  await name.fill("../别处");
  await expect(submit).toBeDisabled();
  await name.fill("已占用.md");
  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("同名");
  await expect(name).toHaveValue("已占用.md");
  await page.screenshot({ path: info.outputPath("conflict.png") });
  await name.fill("雨后复测.MD");
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("雨后复测.md");
  await expect(row).toBeFocused();
  const directory = page.getByRole("group", { name: "目录内容" });
  await expect(row).toHaveCSS("outline-width", "2px");
  await expect(directory).toHaveCSS("outline-style", "none");
  await page.screenshot({ path: info.outputPath("rename-row-focus.png") });
  await directory.focus();
  await expect(directory).toBeFocused();
  await expect(directory).toHaveCSS("outline-width", "2px");
  await expect(row).toHaveCSS("outline-style", "none");
  await expect(page).toHaveURL(otherAddress);
  await expect(page.getByRole("article")).toContainText("继续读这篇");
  const saved = (await (await page.request.get(apiUrl)).json()) as DocumentSnapshot;
  expect(saved).toMatchObject({
    document: {
      id: note.document.id,
      path: "研究/雨后复测.md",
      title: "雨季观察",
      outlineEnabled: true,
    },
    markdown,
    revision: note.revision,
  });
  expect(await (await page.request.get(`${apiUrl}/outline`)).json()).toEqual(outline);
  await page.goto(address);
  await expect(page.getByRole("main").getByRole("heading", { name: "雨季观察" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("雨后复测.md");
  await page.screenshot({ path: info.outputPath("renamed.png") });
});

test.describe("touchscreen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("renames from a touch row and from document more with the directory closed", async ({
    page,
  }, info) => {
    const { address, otherAddress } = await sample(page);
    await page.goto(address);
    await page.getByRole("button", { name: "展开目录" }).tap();
    const more = page.getByRole("button", { name: "已占用更多" });
    await more.tap();
    const rename = page.getByRole("menuitem", { name: "重命名…" });
    await expect(rename).toBeVisible();
    await rename.tap();
    const dialog = page.getByRole("dialog", { name: "重命名文档" });
    const name = dialog.getByLabel("文件名");
    await expect(name).toHaveValue("已占用");
    await name.fill("第一稿");
    await dialog.getByRole("button", { name: "保存文件名" }).tap();
    const renamed = page.getByRole("row", { name: "第一稿", exact: true });
    await expect(renamed).toBeVisible();
    await expect(page).toHaveURL(address);
    await renamed.tap();
    await expect(page).toHaveURL(otherAddress);
    await expect(page.getByRole("button", { name: "展开目录" })).toBeVisible();
    const current = page.getByRole("button", { name: "文档更多" });
    await current.tap();
    await rename.tap();
    await expect(name).toHaveValue("第一稿");
    await name.fill("放弃的文件名");
    await dialog.getByRole("button", { name: "取消" }).tap();
    await expect(current).toBeFocused();
    await current.tap();
    await rename.tap();
    await expect(name).toHaveValue("第一稿");
    await name.fill("最后一稿");
    await dialog.getByRole("button", { name: "保存文件名" }).tap({ trial: true });
    await page.screenshot({ path: info.outputPath("touch-rename.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "保存文件名" }).tap();
    await expect(page.getByRole("main").getByRole("heading", { name: "最后一稿" })).toBeVisible();
    await expect(page).toHaveURL(otherAddress);
  });
});

test("only workspace managers can rename from the document or its directory row", async ({
  page,
  browser,
}) => {
  const { workspace, address, headers } = await sample(page);
  const member = await browser.newPage();
  try {
    const login = await member.request.post("/.auth/librarian/login", {
      headers,
      form: { username: "offline-reader", password: "offline-reader-test-password" },
      maxRedirects: 0,
    });
    expect(login.status()).toBe(303);
    for (const role of ["write", "read"]) {
      expect(
        (
          await page.request.put(`/api/v1/workspaces/${workspace.id}/members/offline-reader`, {
            headers,
            data: { role },
          })
        ).ok(),
      ).toBe(true);
      await member.goto(address);
      await member.getByRole("row", { name: /雨季观察/ }).press("Shift+F10");
      const menu = member.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: /搜索文档/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /重命名/ })).toHaveCount(0);
      await member.keyboard.press("Escape");
      const more = member.getByRole("button", { name: "文档更多" });
      await more.click();
      await expect(menu.getByRole("menuitem", { name: "文档目录" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: /重命名/ })).toHaveCount(0);
      await member.keyboard.press("Escape");
    }
  } finally {
    await member.close();
  }
});

test("retries a lost rename receipt from the right-clicked file without applying an unchanged double extension", async ({
  page,
}) => {
  const { otherAddress, apiUrl, workspace } = await sample(page, "研究/归档.md.md");
  await page.goto(otherAddress);
  const rename = page.getByRole("menuitem", { name: "重命名…" });
  await page.getByRole("row", { name: "研究", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /新建文档/ })).toBeVisible();
  await expect(rename).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("row", { name: /雨季观察/ }).click({ button: "right" });
  await rename.click();
  const dialog = page.getByRole("dialog", { name: "重命名文档" });
  const name = dialog.getByLabel("文件名");
  await expect(name).toHaveValue("归档.md");
  const submit = dialog.getByRole("button", { name: "保存文件名" });
  await expect(submit).toBeDisabled();
  await name.fill("修订版");
  const endpoint = `/api/v1/workspaces/${workspace.id}/rename`;
  await page.route(
    endpoint,
    async (route) => {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort();
    },
    { times: 1 },
  );
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText("重试");
  await expect(name).toHaveValue("修订版");
  await submit.click();
  await expect(dialog).toBeHidden();
  const saved = (await (await page.request.get(apiUrl)).json()) as DocumentSnapshot;
  expect(saved.document.path).toBe("研究/修订版.md");
  await expect(page).toHaveURL(otherAddress);
});
