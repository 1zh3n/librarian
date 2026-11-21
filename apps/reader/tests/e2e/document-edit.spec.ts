import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, OutlineSnapshot } from "../../src/api/client";
import { closeDocumentTool, createNote, openDocumentTool } from "./productFixture";

function editor(page: Page, name: string) {
  return page.locator(`[contenteditable="true"][aria-label="${name}"]`);
}

async function readNote(page: Page, path: string) {
  return (await (await page.request.get(path)).json()) as DocumentSnapshot;
}

test("edits in place without a canvas outline and resumes reading when focus leaves", async ({
  page,
}) => {
  const { apiUrl } = await createNote(
    page,
    "InlineEditor.md",
    "---\ntitle: 就地编辑\n---\n\n在这里继续写。\n",
  );
  const article = page.getByRole("article");
  await article.getByText("在这里继续写。").click();
  const body = editor(page, "Markdown 正文");
  await expect(body).toBeFocused();
  await expect(page.locator(".cm-editor.cm-focused")).toHaveCSS("outline-style", "none");
  await expect(body.getByRole("button", { name: "Front Matter" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返回阅读" })).toHaveCount(0);
  await body.press("End");
  await page.keyboard.insertText("继续写下去。");
  await page.getByRole("button", { name: "文档更多" }).focus();
  await expect(article).toContainText("继续写下去。");
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toContain("继续写下去。");
  await page.keyboard.press("Alt+e");
  await expect(body).toBeFocused();
  await body.press("Control+z");
  await expect(body).not.toContainText("继续写下去。");
  await body.press("Escape");
  await expect(article).toBeFocused();
});

test("places the editor caret at the clicked text within a paragraph", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ClickCaret.md", "甲乙丙丁\n");
  const paragraph = page.getByRole("article").getByText("甲乙丙丁");
  const point = await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Missing paragraph text");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const bounds = range.getBoundingClientRect();
    return { x: bounds.x + 0.5, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await expect(editor(page, "Markdown 正文")).toBeFocused();
  await page.keyboard.insertText("中");
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe("甲乙中丙丁\n");
});

for (const [name, original] of [
  ["short", "\uFEFF---\r\ntitle: 留白\r\n---\r\n\r\n短文。  \r\n\r\n"],
  ["empty", ""],
  ["metadata", "---\ntitle: 只有属性\n---\n"],
] as const) {
  test(`clicking the lower paper resumes writing at the exact end (${name})`, async ({ page }) => {
    const { apiUrl, document } = await createNote(page, `Paper-${name}.md`, original);
    const point = await page.getByRole("article").evaluate((article) => {
      const column = article.getBoundingClientRect();
      const viewport = article.closest("main")!.getBoundingClientRect();
      return { x: column.left + column.width / 2, y: viewport.bottom - 24 };
    });
    const body = editor(page, "Markdown 正文");
    await page.mouse.click(point.x, point.y);
    await expect(body).toBeFocused();
    expect((await readNote(page, apiUrl)).revision).toBe(document.revision);
    await page.keyboard.insertText("初");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(original + "初");
    await body.press("Control+Home");
    await page.mouse.click(point.x, point.y);
    await expect(body).toBeFocused();
    await page.keyboard.insertText("续");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(original + "初续");
    await body.press("Control+z");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(original + "初");
    await body.press("Control+z");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(original);
  });
}

test("the side margins follow the clicked visual line and a paragraph gap uses its nearest edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stanza = "沿岸逐点记录水位。".repeat(18);
  const original = "前言。\n\n" + stanza + "\n\n小结。";
  const { apiUrl } = await createNote(page, "Paper-gutters.md", original);
  const paragraph = page.getByRole("article").getByText(stanza);
  const points = await paragraph.evaluate((element) => {
    const text = element.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const line = range.getClientRects()[1]!;
    const column = element.closest("article")!.getBoundingClientRect();
    const y = line.top + line.height / 2;
    // Determine the actual wrap points independently of the browser's click/caret hit testing.
    let start = -1;
    let end = -1;
    for (let i = 0; i < text.textContent!.length; i++) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      if (Math.abs(range.getBoundingClientRect().top - line.top) < 1) {
        if (start < 0) start = i;
        end = i + 1;
      }
    }
    return [
      { x: column.left - 12, y, at: start },
      { x: column.right + 12, y, at: end },
      {
        x: column.left + 8,
        y: element.getBoundingClientRect().bottom + 3,
        at: text.textContent!.length,
      },
    ];
  });
  const body = editor(page, "Markdown 正文");
  for (const point of points) {
    expect(point.at).toBeGreaterThan(0);
    await page.mouse.click(point.x, point.y);
    await expect(body).toBeFocused();
    await page.keyboard.insertText("光");
    const at = original.indexOf(stanza) + point.at;
    await expect
      .poll(async () => (await readNote(page, apiUrl)).markdown)
      .toBe(original.slice(0, at) + "光" + original.slice(at));
    await body.press("Control+z");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(original);
    await body.press("Escape");
    await expect(paragraph).toBeVisible();
  }
});

test("paper whitespace leaves modified clicks, text selection and surrounding margins in reading", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "Paper-reading.md", "选择这一整段文字。");
  const article = page.getByRole("article");
  const body = editor(page, "Markdown 正文");
  const { left, right, y, bottom } = await article.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("p")!);
    const box = range.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      y: box.top + box.height / 2,
      bottom: element.closest("main")!.getBoundingClientRect().bottom - 32,
    };
  });
  await page.mouse.click(left - 48, bottom);
  await page.mouse.click(left, bottom, { button: "right" });
  await page.keyboard.press("Escape");
  await page.keyboard.down("Alt");
  await page.mouse.click(left, bottom);
  await page.keyboard.up("Alt");
  await page.mouse.move(left + 1, y);
  await page.mouse.down();
  await page.mouse.move(right - 1, y, { steps: 6 });
  await page.mouse.up();
  await expect(body).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("选择这一整段文字。");
});

test("finishes an active IME composition before leaving the editor on blur", async ({ page }) => {
  await createNote(page, "CompositionBlur.md", "继续记录。\n");
  const article = page.getByRole("article");
  await article.getByText("继续记录。").click();
  const body = editor(page, "Markdown 正文");
  await expect(body).toBeFocused();
  await body.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
  );
  await page.getByRole("button", { name: "文档更多" }).focus();
  await expect(body).toBeVisible();
  await body.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await expect(article).toBeVisible();
  await expect(page.getByRole("button", { name: "文档更多" })).toBeFocused();
});

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
  await closeDocumentTool(page);
  await expect(outline).toHaveCount(0);
  await openDocumentTool(page, "提纲");
  await expect(outline).toBeVisible();
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
