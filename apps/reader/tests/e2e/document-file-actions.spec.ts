import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";
import { openFieldWorkspace, signIn } from "./productFixture";

test.use({ viewport: { width: 1440, height: 900 } });

async function setup(page: Page) {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const createSpace = async (name: string) => {
    const response = await page.request.post("/api/v1/workspaces", {
      headers,
      data: { name },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as Workspace;
  };
  const source = await createSpace("渡口走访");
  const target = await createSpace("船队档案 " + randomUUID().slice(0, 6));
  const write = async (workspace: string, path: string, markdown: string) => {
    const response = await page.request.post(`/api/v1/workspaces/${workspace}/documents`, {
      headers,
      data: { path, markdown, baseRevision: null },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as DocumentSnapshot;
  };
  const current = await write(
    source.id,
    "走访手记.md",
    "# 渡口走访手记\n\n" + "雨停后，渡船又出发了。\n\n".repeat(120),
  );
  const note = await write(source.id, "资料/访谈.md", "# 访谈\n\n船工记录。\n");
  const address = `/workspaces/${source.id}/documents/${current.document.id}`;
  await page.goto(address);
  return { source, target, current, note, address, headers, write };
}

test("manages the targeted document from the directory while another stays open", async ({
  page,
}, info) => {
  const { address } = await setup(page);
  const row = page.getByRole("row", { name: /访谈/ });
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "目录操作" });
  for (const name of ["重命名…", "移动到…", "复制到…", "删除…"]) {
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("directory-menu.png") });
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(address);
});

test("save errors and directory notices share one visible stack", async ({ page }, info) => {
  const { current, target, note, headers } = await setup(page);
  const folder = await page.request.post(`/api/v1/workspaces/${target.id}/folders`, {
    headers,
    data: { path: "归档" },
  });
  expect(folder.status()).toBe(200);
  await page
    .getByRole("article")
    .getByText("雨停后", { exact: false })
    .first()
    .click({ position: { x: 8, y: 16 } });
  const body = page.locator('[contenteditable="true"][aria-label="Markdown 正文"]');
  await body.press("Control+End");
  await page.route(`**/api/v1/documents/${current.document.id}`, (route) =>
    route.request().method() === "PUT" ? route.abort("failed") : route.continue(),
  );
  await page.keyboard.insertText("未保存");
  const saving = page.getByRole("alert").filter({ hasText: "保存失败" });
  await expect(saving).toBeVisible();

  const row = page.getByRole("row", { name: /访谈/ });
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "复制到…" }).click();
  const dialog = page.getByRole("dialog", { name: "复制到", exact: true });
  await dialog.getByRole("button", { name: /目标空间/ }).click();
  await page.getByRole("option", { name: target.name, exact: true }).click();
  await dialog.getByRole("button", { name: /目标目录/ }).click();
  await page.getByRole("option", { name: "归档", exact: true }).click();
  await dialog.getByRole("button", { name: "复制到此处" }).click();
  await expect(dialog).toBeHidden();

  const stack = page.getByRole("region", { name: "通知" });
  await expect(stack).toBeVisible();
  const copied = stack.getByRole("status").filter({ hasText: /已复制到/ });
  await expect(saving).toBeVisible();
  await expect(copied).toBeVisible();
  const [saveBox, copyBox] = await Promise.all([saving.boundingBox(), copied.boundingBox()]);
  expect(saveBox && copyBox).toBeTruthy();
  expect(
    saveBox!.y + saveBox!.height <= copyBox!.y || copyBox!.y + copyBox!.height <= saveBox!.y,
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("notification-stack-1440.png") });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const bounds = await stack.boundingBox();
  expect(bounds?.x ?? 0).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const retry = saving.getByRole("button", { name: "重试" });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  await expect(copied).toBeVisible();
  await page.screenshot({ path: info.outputPath("notification-stack-390-200.png") });
  expect(note.document.id).not.toBe(current.document.id);
});

test("opens an old member link at the document's currently authorized location", async ({
  page,
}) => {
  const { source, target, note } = await setup(page);
  const current = `/workspaces/${source.id}/documents/${note.document.id}`;
  await page.goto(`/workspaces/${target.id}/documents/${note.document.id}#reading-section`);
  await expect(page).toHaveURL(current + "#reading-section");
  await expect(page.getByRole("article")).toContainText("船工记录。");
});

test("moves across spaces, shows the access change and preserves the open reading position", async ({
  page,
  browser,
}, info) => {
  const { note, source, target, address, headers, write } = await setup(page);
  await write(target.id, "归档/索引.md", "目录索引");
  const username = "archive-" + randomUUID();
  const password = "archive-member-test-password";
  const member = await browser.newContext({ baseURL: headers.origin });
  const memberPage = await member.newPage();
  await signIn(memberPage, "fixture-admin", "fixture-admin-test-password");
  const created = await memberPage.request.post("/api/v1/accounts", {
    headers,
    data: { username, password },
  });
  expect(created.ok()).toBe(true);
  await member.clearCookies();
  const grant = (workspace: string) =>
    page.request.put(`/api/v1/workspaces/${workspace}/members/${username}`, {
      headers,
      data: { role: "read" },
    });
  expect((await grant(target.id)).ok()).toBe(true);
  const article = page.getByRole("article");
  await expect(article).toContainText("雨停后");
  const reading = page.getByRole("main");
  const initial = await reading.evaluate((el) => {
    el.scrollTop = 560;
    return el.scrollTop;
  });
  expect(initial).toBeGreaterThan(100);
  const row = page.getByRole("row", { name: /访谈/ });
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "移动到…" }).click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });
  await dialog.getByRole("button", { name: /目标空间/ }).click();
  await page.getByRole("option", { name: target.name, exact: true }).click();
  await dialog.getByRole("button", { name: /目标目录/ }).click();
  await page.getByRole("option", { name: "归档", exact: true }).click();
  await expect(dialog).toContainText(/1 位.*读/u);
  await page.screenshot({ path: info.outputPath("permission-preview.png") });
  await dialog.getByRole("button", { name: "移动到此处" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "查看位置" })).toBeVisible();
  await expect(page).toHaveURL(address);
  await expect(article).toContainText("渡口走访手记");
  expect(await reading.evaluate((el) => el.scrollTop)).toBe(initial);
  const moved = await page.request.get(`/api/v1/documents/${note.document.id}`);
  expect(moved.ok()).toBe(true);
  expect(await moved.json()).toMatchObject({
    document: { workspaceId: target.id, path: "归档/访谈.md" },
    markdown: note.markdown,
  });
  await page.getByRole("button", { name: "查看位置" }).click();
  await expect(page.getByRole("row", { name: /访谈/ })).toBeVisible();
  await page.goto(`/workspaces/${source.id}/documents/${note.document.id}`);
  await expect(page).toHaveURL(`/workspaces/${target.id}/documents/${note.document.id}`);
  try {
    const oldLink = `/workspaces/${source.id}/documents/${note.document.id}#reading-section`;
    await signIn(memberPage, username, password);
    await memberPage.goto(oldLink);
    await expect(memberPage).toHaveURL(
      `/workspaces/${target.id}/documents/${note.document.id}#reading-section`,
    );
    await expect(memberPage.getByRole("article")).toContainText("船工记录。");
    expect((await grant(source.id)).ok()).toBe(true);
    const revoked = await page.request.delete(
      `/api/v1/workspaces/${target.id}/members/${username}`,
      { headers },
    );
    expect(revoked.ok()).toBe(true);
    await memberPage.goto(oldLink);
    await expect(memberPage.getByText(/无法读取文档|此文档不存在/u)).toBeVisible();
    await expect(memberPage.getByRole("article")).toHaveCount(0);
    await expect(memberPage).toHaveURL(oldLink);
  } finally {
    await member.close();
  }
});

test.describe("touch file management", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("copies to an empty folder and undoes deletion of that folder", async ({ page }, info) => {
    const { source, target, note, headers, address } = await setup(page);
    const folder = await page.request.post(`/api/v1/workspaces/${target.id}/folders`, {
      headers,
      data: { path: "归档" },
    });
    expect(folder.status()).toBe(200);
    await page.getByRole("button", { name: "展开目录" }).tap();
    const row = page.getByRole("row", { name: /访谈/ });
    await row.getByRole("button", { name: /更多/ }).tap();
    await page.getByRole("menuitem", { name: "复制到…" }).tap();
    const dialog = page.getByRole("dialog", { name: "复制到", exact: true });
    await dialog.getByRole("button", { name: /目标空间/ }).tap();
    await page.getByRole("option", { name: target.name, exact: true }).tap();
    await dialog.getByRole("button", { name: /目标目录/ }).tap();
    await page.getByRole("option", { name: "归档", exact: true }).tap();
    const submit = dialog.getByRole("button", { name: "复制到此处" });
    await expect(submit).toBeEnabled();
    await expect(dialog).not.toContainText("位成员");
    await page.screenshot({ path: info.outputPath("touch-copy.png") });
    await submit.tap();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(address);
    const documents = async () =>
      (await (
        await page.request.get(`/api/v1/workspaces/${target.id}/documents`)
      ).json()) as DocumentSnapshot["document"][];
    const copy = (await documents()).find((item) => item.path === "归档/访谈.md");
    expect(copy).toBeDefined();
    expect(copy?.id).not.toBe(note.document.id);
    await page.getByRole("button", { name: "查看位置" }).tap();
    const folderRow = page.getByRole("row", { name: "归档", exact: true });
    await expect(folderRow).toBeVisible();
    await folderRow.getByRole("button", { name: /更多/ }).tap();
    await page.getByRole("menuitem", { name: "删除…" }).tap();
    const deletion = page.getByRole("dialog", { name: "删除文件夹" });
    await expect(deletion).toContainText("归档");
    await deletion.getByRole("button", { name: "删除", exact: true }).tap();
    await expect(deletion).toBeHidden();
    await expect(folderRow).toHaveCount(0);
    await page.getByRole("button", { name: "撤销", exact: true }).tap();
    await expect(folderRow).toBeVisible();
    const restored = (await documents()).find((item) => item.path === "归档/访谈.md");
    expect(restored?.id).toBe(copy?.id);
    const original = await page.request.get(`/api/v1/documents/${note.document.id}`);
    expect(await original.json()).toMatchObject({
      document: { workspaceId: source.id, path: note.document.path },
      markdown: note.markdown,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});

test("can change the destination after a collision and create a folder in place", async ({
  page,
}) => {
  const { source, address, note, write } = await setup(page);
  await write(source.id, "归档/访谈.md", "原来的记录");
  await page.reload();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("访谈", { exact: true }) })
    .first();
  const original = page.locator(`[data-context-document="${note.document.id}"]`);
  await expect(row).toBeVisible();
  await original.press("Shift+F10");
  await page.getByRole("menuitem", { name: "移动到…" }).click();
  const dialog = page.getByRole("dialog", { name: "移动到", exact: true });
  await dialog.getByRole("button", { name: /目标目录/ }).click();
  await page.getByRole("option", { name: "归档", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("同名");
  await expect(dialog.getByRole("button", { name: "移动到此处" })).toBeDisabled();
  await dialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await dialog.getByRole("textbox", { name: "文件夹名称" }).fill("录音");
  await dialog.getByRole("button", { name: "创建文件夹", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /目标目录/ })).toContainText("归档/录音");
  await dialog.getByRole("button", { name: "移动到此处" }).click();
  await expect(dialog).toBeHidden();
  await expect(original).toBeFocused();
  await expect(page).toHaveURL(address);
  expect(
    await (await page.request.get(`/api/v1/documents/${note.document.id}`)).json(),
  ).toMatchObject({
    document: { path: "归档/录音/访谈.md", id: note.document.id },
    markdown: note.markdown,
  });
});

test.describe("empty folder destinations", () => {
  test.use({ viewport: { width: 320, height: 700 }, hasTouch: true });
  test("reveals the copied empty folder in a workspace with no documents", async ({
    page,
  }, info) => {
    const { target } = await setup(page);
    await page.getByRole("button", { name: "展开目录" }).tap();
    await page.getByRole("button", { name: "根目录更多" }).tap();
    await page.getByRole("menuitem", { name: "新建文件夹…" }).tap();
    const create = page.getByRole("dialog", { name: "新建文件夹" });
    await create.getByRole("textbox", { name: "文件夹名称" }).fill("空白访谈");
    await create.getByRole("button", { name: "创建文件夹" }).tap();
    const source = page.getByRole("row", { name: "空白访谈", exact: true });
    await source.getByRole("button", { name: /更多/u }).tap();
    await page.getByRole("menuitem", { name: "复制到…" }).tap();
    const dialog = page.getByRole("dialog", { name: "复制到", exact: true });
    await dialog.getByRole("button", { name: /目标空间/u }).tap();
    await page.getByRole("option", { name: target.name, exact: true }).tap();
    await dialog.getByRole("button", { name: "新建文件夹", exact: true }).tap();
    await dialog.getByRole("textbox", { name: "文件夹名称" }).fill("归档");
    await dialog.getByRole("button", { name: "创建文件夹" }).tap();
    const submit = dialog.getByRole("button", { name: "复制到此处" });
    await expect(submit).toBeEnabled();
    expect(
      await submit.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return Math.min(rect.width, rect.height);
      }),
    ).toBeGreaterThanOrEqual(44);
    await submit.tap();
    await page.getByRole("button", { name: "查看位置", exact: true }).tap();
    await expect(page).toHaveURL(`/workspaces/${target.id}`);
    const copied = page.locator('[data-context-path="归档/空白访谈"]');
    await expect(copied).toBeVisible();
    await expect(copied).toBeFocused();
    await expect(copied).toHaveAttribute("data-command-target", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await expect(page.getByRole("main")).toContainText("这个空间还没有文档");
    expect(
      (await (await page.request.get(`/api/v1/workspaces/${target.id}/folders`)).json()).folders,
    ).toContain("归档/空白访谈");
    await page.screenshot({ path: info.outputPath("empty-folder-location.png") });
  });
});

test("a picker keeps the original folder identity across a directory refresh", async ({ page }) => {
  const { source, headers } = await setup(page);
  const api = `/api/v1/workspaces/${source.id}`;
  const listed = (await (await page.request.get(api + "/folders")).json()) as {
    identities: Record<string, string>;
  };
  const original = listed.identities?.["资料"];
  expect(original).toBeTruthy();
  const row = page.getByRole("row", { name: "资料", exact: true });
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "复制到…" }).click();
  const dialog = page.getByRole("dialog", { name: "复制到", exact: true });
  expect(
    (
      await page.request.post(api + "/rename", {
        headers,
        data: { operationId: randomUUID(), from: "资料", to: "旧资料" },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (await page.request.post(api + "/folders", { headers, data: { path: "资料" } })).ok(),
  ).toBe(true);
  await dialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
  await dialog.getByRole("textbox", { name: "文件夹名称" }).fill("收件箱");
  const refreshed = page.waitForResponse(
    (res) => res.url().endsWith(api + "/folders") && res.request().method() === "GET",
  );
  const preview = page.waitForResponse((res) => res.url().endsWith("/file-actions/preview"));
  await dialog.getByRole("button", { name: "创建文件夹" }).click();
  const next = (await (await refreshed).json()) as { identities: Record<string, string> };
  expect(next.identities["资料"]).not.toBe(original);
  const rejected = await preview;
  expect(rejected.request().postDataJSON()).toMatchObject({
    sourceKind: "folder",
    sourcePath: "资料",
    expectedFolderId: original,
  });
  expect(rejected.status()).toBe(409);
  await expect(dialog.getByRole("button", { name: "复制到此处" })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(row).toBeFocused();
});

test("deleting a folder waits for its open draft and replays a gateway failure before undo", async ({
  page,
}) => {
  const { source, note } = await setup(page);
  await page.goto(`/workspaces/${source.id}/documents/${note.document.id}`);
  await page.getByRole("article").getByText("船工记录。").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  let releaseSave = () => {};
  const save = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saveStarted = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && request.url().endsWith(`/api/v1/documents/${note.document.id}`),
  );
  await page.route(`**/api/v1/documents/${note.document.id}`, async (route) => {
    if (route.request().method() === "PUT") {
      await save;
    }
    await route.continue();
  });
  const previews: string[] = [];
  const operations: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/file-actions/preview")) previews.push(req.url());
  });
  await page.route("**/file-actions/apply", async (route) => {
    const body = route.request().postData() ?? "";
    operations.push(body);
    const result = await route.fetch();
    expect(result.ok()).toBe(true);
    if (operations.length === 1)
      await route.fulfill({ status: 502, body: "upstream connection closed" });
    else await route.fulfill({ response: result });
  });
  await page.keyboard.insertText("等待保存的记录");
  await page.getByRole("row", { name: "资料", exact: true }).press("Shift+F10");
  await page.getByRole("menuitem", { name: "删除…" }).click();
  const dialog = page.getByRole("dialog", { name: "删除文件夹" });
  await saveStarted;
  try {
    await expect(dialog.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
    expect(previews).toHaveLength(0);
  } finally {
    releaseSave();
  }
  const submit = dialog.getByRole("button", { name: "删除", exact: true });
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText("回执");
  await submit.click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(`[data-context-document="${note.document.id}"]`)).toBeVisible();
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
  expect(previews).toHaveLength(1);
  expect(
    (await (await page.request.get(`/api/v1/documents/${note.document.id}`)).json()).markdown,
  ).toContain("等待保存的记录");
});

test("a failed draft save blocks its own deletion and leaves another row's copy usable", async ({
  page,
}) => {
  const { address, source, current, note } = await setup(page);
  const saves: string[] = [];
  await page.route(`**/api/v1/documents/${current.document.id}`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    saves.push(route.request().postData() ?? "");
    await route.fulfill({ status: 503 });
  });
  await page
    .getByRole("article")
    .getByText("雨停后，渡船又出发了。", { exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("未同步的走访手记");
  const active = page.locator(`[data-context-document="${current.document.id}"]`);
  await active.press("Shift+F10");
  await page.getByRole("menuitem", { name: "删除…" }).click();
  const deletion = page.getByRole("dialog", { name: "删除文档" });
  await expect(deletion.getByRole("alert")).toContainText("先保存");
  await expect(deletion.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
  await deletion.getByRole("button", { name: "取消" }).click();
  await expect(active).toBeFocused();
  const attempts = saves.length;
  expect(attempts).toBeGreaterThan(0);
  await page.locator(`[data-context-document="${note.document.id}"]`).press("Shift+F10");
  await page.getByRole("menuitem", { name: "复制到…" }).click();
  const copy = page.getByRole("dialog", { name: "复制到", exact: true });
  await copy.getByRole("button", { name: /目标目录/u }).click();
  await page.getByRole("option", { name: "根目录", exact: true }).click();
  await copy.getByRole("button", { name: "复制到此处" }).click();
  await expect(copy).toBeHidden();
  await expect(page).toHaveURL(address);
  await expect(page.locator('[data-context-path="访谈.md"]')).toBeFocused();
  await expect(page.getByRole("article")).toContainText("未同步的走访手记");
  await page.keyboard.press("Alt+e");
  await expect(editor).toContainText("未同步的走访手记");
  expect(saves).toHaveLength(attempts);
  const docs = (await (
    await page.request.get(`/api/v1/workspaces/${source.id}/documents`)
  ).json()) as DocumentSnapshot["document"][];
  expect(docs.find((d) => d.path === "访谈.md")?.id).toBeTruthy();
});
