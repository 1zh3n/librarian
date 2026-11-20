import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, OutlineSnapshot } from "../../src/api/client";
import { createNote } from "./productFixture";

function editor(page: Page, name: string) {
  return page.locator(`[contenteditable="true"][aria-label="${name}"]`);
}

async function readNote(page: Page, path: string) {
  return (await (await page.request.get(path)).json()) as DocumentSnapshot;
}

test("save response keeps edits typed while waiting", async ({ page }) => {
  const before = "\uFEFF---\r\ntitle: 测试慢保存\r\n---\r\n初稿";
  const { apiUrl, document } = await createNote(page, "SaveQueue.md", before);
  const writes: { markdown: string; baseRevision: string }[] = [];
  let releaseFirst = () => {};
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let afterFirst = "";
  await page.route(`**${apiUrl}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const write = route.request().postDataJSON() as (typeof writes)[number];
    writes.push(write);
    const response = await route.fetch();
    if (writes.length === 1) {
      afterFirst = ((await response.json()) as DocumentSnapshot).revision;
      await held;
    }
    await route.fulfill({ response });
  });
  await page.getByRole("article").getByText("初稿").click();
  const body = editor(page, "Markdown 正文");
  try {
    await body.press("Control+End");
    await page.keyboard.insertText("甲");
    await expect.poll(() => writes.length).toBe(1);
    await page.keyboard.insertText("乙");
    expect(writes).toEqual([{ markdown: before + "甲", baseRevision: document.revision }]);
  } finally {
    releaseFirst();
  }
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(before + "甲乙");
  await expect(page.getByText("已保存")).toBeVisible();
  expect(writes).toEqual([
    { markdown: before + "甲", baseRevision: document.revision },
    { markdown: before + "甲乙", baseRevision: afterFirst },
  ]);
  await page.reload();
  await expect(page.getByRole("article")).toContainText("初稿甲乙");
});

test("outline and body use independent revisions and sessions", async ({ page }) => {
  const before = "# 记录\n\n正文保持原样。\n";
  const { apiUrl, document } = await createNote(page, "IndependentOutline.md", before);
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "添加提纲" }).click();
  const outline = editor(page, "Markdown 提纲");
  await expect(outline).toBeFocused();
  await page.keyboard.insertText("写作提纲");
  const persisted = async () =>
    (await (await page.request.get(`${apiUrl}/outline`)).json()) as OutlineSnapshot;
  await expect.poll(async () => (await persisted()).markdown).toBe("写作提纲");
  await expect(page.getByText("已保存")).toBeVisible();
  await page.getByRole("button", { name: "提纲", exact: true }).click();
  await expect(outline).toHaveCount(0);
  await page.getByRole("button", { name: "提纲", exact: true }).click();
  await expect(outline).toBeFocused();
  await outline.press("Control+z");
  await expect.poll(async () => (await persisted()).markdown).toBe("");
  expect(await readNote(page, apiUrl)).toEqual({
    ...document,
    document: { ...document.document, outlineEnabled: true },
  });
});

test("source mode reuses the selection and undo history", async ({ page }) => {
  const { apiUrl } = await createNote(page, "SourceMode.md", "---\ntitle: 同一会话\n---\n\n初稿\n");
  await page.getByRole("article").getByText("初稿").click();
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await page.keyboard.insertText("可撤销");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "完整源码" }).click();
  await expect(body).toContainText("title: 同一会话");
  await expect(body).toBeFocused();
  await body.press("Control+z");
  await expect(body).not.toContainText("可撤销");
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe("---\ntitle: 同一会话\n---\n\n初稿\n");
});

test("connectivity loss retains the draft and reconnect saves it", async ({ page, context }) => {
  const { apiUrl } = await createNote(page, "OfflineDraft.md", "离线前的正文");
  await page.getByRole("article").getByText("离线前的正文").click();
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await context.setOffline(true);
  await page.keyboard.insertText("，本地续写");
  await expect(page.getByRole("alert")).toContainText("网络恢复后会重试");
  await expect(body).toContainText("本地续写");
  expect((await readNote(page, apiUrl)).markdown).toBe("离线前的正文");
  await context.setOffline(false);
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe("离线前的正文，本地续写");
  await expect(page.getByText("已保存")).toBeVisible();
});

test("a stale save keeps the local buffer and the remote file", async ({ page }) => {
  const { apiUrl, document, origin } = await createNote(page, "StaleBody.md", "共同原件");
  await page.getByRole("article").getByText("共同原件").click();
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  const remote = await page.request.put(apiUrl, {
    headers: { origin },
    data: { markdown: "远程版本", baseRevision: document.revision },
  });
  expect(remote.ok()).toBe(true);
  await page.keyboard.insertText("本地草稿");
  await expect(page.getByRole("alert")).toContainText("服务器上的正文已更新");
  await expect(body).toContainText("共同原件本地草稿");
  expect((await readNote(page, apiUrl)).markdown).toBe("远程版本");
});

test("adding a tag through the document uses a byte-preserving save", async ({ page }) => {
  const before =
    "\uFEFF---\r\ntitle: 文件属性 # 备注\r\ntags: note design  # 原标签\r\nx-custom: [1, 2]\r\n---\r\n真实正文  \n";
  const { apiUrl } = await createNote(page, "MetadataForm.md", before);
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "文档属性" }).click();
  await page.getByLabel("添加标签").fill("河岸");
  await page.getByRole("button", { name: "保存属性" }).click();
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe(before.replace("note design ", "note design 河岸 "));
});

test("a failed workspace refetch leaves the live draft mounted", async ({ page }) => {
  const { apiUrl } = await createNote(page, "RefetchDraft.md", "本地编辑");
  await page.getByRole("article").getByText("本地编辑").click();
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await page.route(`**${apiUrl}`, (route) =>
    route.request().method() === "PUT" ? route.abort("failed") : route.continue(),
  );
  await page.keyboard.insertText("继续保留");
  await expect(page.getByRole("alert")).toContainText("保存失败");
  await page.clock.install();
  await page.clock.fastForward(21_000);
  await page.route("**/api/v1/workspaces", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "test_unavailable", message: "Temporary outage" },
    }),
  );
  const request = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/workspaces") && response.status() === 503,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await request;
  await expect(body).toContainText("本地编辑继续保留");
});
