import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

const markdown = "---\ntitle: 雨季观察\n---\n\n## 河岸\n\n记录初夏的水位。\n";
async function loginAdmin(request: APIRequestContext, origin: string) {
  const login = await request.post("/.auth/librarian/login", {
    headers: { origin },
    form: { username: "fixture-admin", password: "fixture-admin-test-password" },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
}

test("bound rename rejects a reused source path and replays only the original request", async ({
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Expected the Reader fixture URL");
  const headers = { origin: new URL(baseURL).origin };
  await loginAdmin(request, headers.origin);
  const created = await request.post("/api/v1/workspaces", {
    headers,
    data: { name: "重命名回执" },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as Workspace;
  const api = `/api/v1/workspaces/${workspace.id}`;
  const from = "草稿/原名.md";
  const add = async () => {
    const response = await request.post(`${api}/documents`, {
      headers,
      data: { path: from, markdown, baseRevision: null },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as DocumentSnapshot;
  };
  const original = await add();
  const move = {
    operationId: randomUUID(),
    from,
    to: "归档.md",
    expectedDocumentId: original.document.id,
  };
  const rename = (data: typeof move) => request.post(`${api}/rename`, { headers, data });
  const receipt = await rename(move);
  expect(receipt.status()).toBe(200);
  const replacement = await add();
  expect(replacement.document.id).not.toBe(original.document.id);
  const stale = await rename({ ...move, operationId: randomUUID(), to: "意外.md" });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "rename_source_changed" });
  expect(await (await rename(move)).json()).toEqual(await receipt.json());
  const reused = await rename({ ...move, expectedDocumentId: replacement.document.id });
  expect(reused.status()).toBe(409);
  expect(await reused.json()).toMatchObject({ code: "operation_id_reused" });
  const snapshot = (id: string) =>
    request.get(`/api/v1/documents/${id}`).then((response) => response.json());
  expect(await snapshot(original.document.id)).toMatchObject({ path: move.to, markdown });
  expect(await snapshot(replacement.document.id)).toEqual(replacement);
  const directory = await request.post(`${api}/rename`, {
    headers,
    data: { operationId: randomUUID(), from: "草稿", to: "稿件" },
  });
  expect(directory.status()).toBe(200);
  expect(await snapshot(replacement.document.id)).toMatchObject({ path: "稿件/原名.md", markdown });
});

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
  const row = page.getByRole("row", { name: /旧档\.md/ });
  await row.press("Shift+F10");
  const rename = page.getByRole("menuitem", { name: "重命名…" });
  await expect(rename).toBeVisible();
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
  const submitted = page.waitForRequest(
    (req) => req.url().endsWith("/rename") && req.method() === "POST",
  );
  await name.press("Enter");
  expect((await submitted).postDataJSON()).toMatchObject({ expectedDocumentId: note.document.id });
  await expect(dialog).toBeHidden();
  const renamed = page.getByRole("row", { name: "雨后复测.md", exact: true });
  await expect(renamed).toContainText("雨后复测.md");
  await expect(renamed).toBeFocused();
  const directory = page.getByRole("group", { name: "目录内容" });
  await expect(renamed).toHaveCSS("outline-width", "2px");
  await expect(directory).toHaveCSS("outline-style", "none");
  await page.screenshot({ path: info.outputPath("rename-row-focus.png") });
  await directory.focus();
  await expect(directory).toBeFocused();
  await expect(directory).toHaveCSS("outline-width", "2px");
  await expect(renamed).toHaveCSS("outline-style", "none");
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

test("a stale document menu cannot rename the replacement at the original path", async ({
  page,
  request,
}) => {
  const { address, apiUrl, workspace, note, headers } = await sample(page);
  await page.goto(address);
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  const dialog = page.getByRole("dialog", { name: "重命名文档" });
  const name = dialog.getByLabel("文件名");
  await name.fill("原计划文件名");

  await loginAdmin(request, headers.origin);
  const api = `/api/v1/workspaces/${workspace.id}`;
  const moved = await request.post(`${api}/rename`, {
    headers,
    data: { operationId: randomUUID(), from: note.document.path, to: "归档.md" },
  });
  expect(moved.status()).toBe(200);
  const created = await request.post(`${api}/documents`, {
    headers,
    data: { path: note.document.path, markdown, baseRevision: null },
  });
  expect(created.status()).toBe(201);
  const replacement = (await created.json()) as DocumentSnapshot;

  const response = page.waitForResponse((res) => res.url().endsWith(`${api}/rename`));
  await dialog.getByRole("button", { name: "保存文件名" }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("原路径");
  await expect(name).toHaveValue("原计划文件名");
  expect(await (await request.get(apiUrl)).json()).toMatchObject({ path: "归档.md", markdown });
  expect(await (await request.get(`/api/v1/documents/${replacement.document.id}`)).json()).toEqual(
    replacement,
  );
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("banner")).toContainText("归档.md");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "重命名…" }).click();
  await expect(name).toHaveValue("归档");
});

test.describe("touchscreen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("renames from a touch row and from document more with the directory closed", async ({
    page,
  }, info) => {
    const { address, otherAddress } = await sample(page);
    await page.goto(address);
    await page.getByRole("button", { name: "展开目录" }).tap();
    const more = page.getByRole("button", { name: "已占用.md更多" });
    await more.tap();
    const rename = page.getByRole("menuitem", { name: "重命名…" });
    await expect(rename).toBeVisible();
    await rename.tap();
    const dialog = page.getByRole("dialog", { name: "重命名文档" });
    const name = dialog.getByLabel("文件名");
    await expect(name).toHaveValue("已占用");
    await name.fill("第一稿");
    await dialog.getByRole("button", { name: "保存文件名" }).tap();
    const renamed = page.getByRole("row", { name: "第一稿.md", exact: true });
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
      await member.getByRole("row", { name: /旧档\.md/ }).press("Shift+F10");
      const menu = member.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: /搜索文档/ })).toHaveCount(0);
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
  await expect(rename).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("row", { name: /归档\.md\.md/ }).click({ button: "right" });
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
