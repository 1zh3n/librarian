import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot } from "../../src/api/client";
import type { components } from "../../src/api/schema.gen";
import { closeDocumentTool, createNote, openDocumentTool } from "./productFixture";

type Claim = components["schemas"]["AiClaim"];
type RunnerResult = components["schemas"]["AiRunnerResult"];
type Source = components["schemas"]["AiSourceData"];

const runner = "/api/v1/ai/runner/claims";
const headers = { authorization: "Bearer reader-fixture-ai-token-only-for-tests" };

async function claim(page: Page) {
  const response = await page.request.post(runner, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as Claim;
}

async function readSource(page: Page, task: Claim, documentId: string, outline = false) {
  const response = await page.request.post(`${runner}/${task.leaseId}/sources`, {
    headers,
    data: { documentId, outline },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Source;
}

async function complete(page: Page, task: Claim, data: RunnerResult) {
  const response = await page.request.put(`${runner}/${task.leaseId}/result`, { headers, data });
  expect(response.ok()).toBe(true);
}

async function send(page: Page, prompt: string, edit = false) {
  const form = page.getByRole("form", { name: "AI 请求" });
  await form.getByRole("textbox", { name: "提示词" }).fill(prompt);
  const request = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: edit ? "修改" : "询问", exact: true }).click();
  expect((await request).status()).toBe(202);
  return claim(page);
}

async function addNote(page: Page, workspace: string, path: string, markdown: string) {
  const response = await page.request.post(`/api/v1/workspaces/${workspace}/documents`, {
    headers: { origin: new URL(page.url()).origin },
    data: { path, markdown, baseRevision: null },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as DocumentSnapshot;
}

test("document AI leaves text readable at desktop and 360px", async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 850 });
  await createNote(page, "AiLayout.md", "# 读写距离\n\n对话期间可继续阅读。\n");
  const article = page.getByRole("article");
  await expect(article).toContainText("对话期间可继续阅读。");
  const before = await article.boundingBox();
  await expect(page.getByRole("button", { name: "打开文档辅助区" })).toHaveCount(1);
  await openDocumentTool(page, "AI");
  const panel = page.getByRole("region", { name: "文档 AI" });
  await expect(panel).toBeVisible();
  expect((await article.boundingBox())?.width).toBe(before?.width);
  const aside = await panel.boundingBox();
  expect(aside && before && aside.x >= before.x + before.width).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await closeDocumentTool(page);
  await expect(panel).toBeHidden();

  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(async () => (await article.boundingBox())?.width ?? 0).toBeGreaterThan(300);
  const narrow = await article.boundingBox();
  await openDocumentTool(page, "AI");
  await expect(panel).toBeVisible();
  const text = await article.boundingBox();
  const side = await panel.boundingBox();
  expect(text?.width).toBe(narrow?.width);
  expect(side && text && side.y + side.height <= text.y).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test("only the AI input draws a focus border, including when actions receive focus", async ({
  page,
}) => {
  await createNote(page, "AiComposerFocus.md", "正文\n");
  await openDocumentTool(page, "AI");
  const form = page.getByRole("form", { name: "AI 请求" });
  const input = form.getByRole("textbox", { name: "提示词" });
  const toolTabs = page.getByRole("tablist", { name: "文档工具" }).locator("..");
  await expect(input).toHaveCSS("border-top-width", "1px");
  await input.fill("这是一条待发送的问题");
  await expect(input).toBeFocused();
  await expect(input).toHaveCSS("outline-style", "solid");
  await expect(form).toHaveCSS("border-top-width", "0px");
  await expect(toolTabs).toHaveCSS("outline-style", "none");
  const submit = form.getByRole("button", { name: "询问" });
  await input.press("Tab");
  await expect(submit).toBeFocused();
  await expect(form).toHaveCSS("border-top-width", "0px");
  await expect(toolTabs).toHaveCSS("outline-style", "none");
});

test("document AI sends selection and displays only actual sources", async ({ page }) => {
  const markdown = "# 摘要\n\n大雨过后🌱选择这一段，再看其他内容。\n";
  const { document } = await createNote(page, "AiSources.md", markdown);
  const workspace = document.document.workspaceId;
  const referenced = await addNote(page, workspace, "北岸/观测.md", "北岸记录");
  const untouched = await addNote(page, workspace, "北岸/未读.md", "这份没有被读");
  await page.reload();
  const paragraph = page.getByRole("article").getByText("大雨过后", { exact: false });
  await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Missing selected text");
    const start = (text.textContent ?? "").indexOf("🌱");
    const range = new Range();
    range.setStart(text, start);
    range.setEnd(text, start + "🌱选择这一段".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await openDocumentTool(page, "AI");
  const selected = await send(page, "解释所选内容");
  expect(selected.input.context).toEqual([
    expect.objectContaining({
      documentId: document.document.id,
      revision: document.revision,
      from: markdown.indexOf("🌱"),
      to: markdown.indexOf("🌱") + "🌱选择这一段".length,
    }),
  ]);
  const selectedText = await readSource(page, selected, document.document.id);
  expect(selectedText.markdown).toBe("🌱选择这一段");
  await complete(page, selected, { answer: "选区已解释", sourceIds: [selectedText.source.id] });
  await expect(page.getByText("选区已解释")).toBeVisible();

  const task = await send(page, "概述 @北岸/");
  expect(task.input.context?.map((context) => context.documentId).sort()).toEqual(
    [referenced.document.id, untouched.document.id].sort(),
  );
  const source = await readSource(page, task, referenced.document.id);
  await complete(page, task, { answer: "已确认北岸记录", sourceIds: [source.source.id] });
  await expect(page.getByText("已确认北岸记录")).toBeVisible();
  const sources = page.getByRole("list", { name: "引用来源" }).last();
  await expect(sources.getByRole("link")).toHaveCount(1);
  await expect(sources.getByRole("link", { name: "北岸/观测.md" })).toHaveAttribute(
    "href",
    `/workspaces/${workspace}/documents/${referenced.document.id}#reader-source?revision=${referenced.revision}`,
  );
  await expect(sources).not.toContainText("北岸/未读.md");
});

for (const width of [1440, 390]) {
  test(`returns from an AI source to the same answer and reading passage at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const markdown = Array.from({ length: 75 }, (_, i) => `第${i + 1}段，沿河向北记录水位。`).join(
      "\n\n",
    );
    const { document, pathToNote } = await createNote(page, `来源往返-${width}.md`, markdown);
    const reference = await addNote(
      page,
      document.document.workspaceId,
      `水位-${width}.md`,
      "北岸的水尺读数。",
    );
    const passage = page.getByRole("article").getByText("第40段，沿河向北记录水位。");
    await passage.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const passageTop = () => passage.evaluate((el) => el.getBoundingClientRect().top);
    const beforeOpening = await passageTop();
    await passage.evaluate((element) => {
      const range = new Range();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await openDocumentTool(page, "AI");
    const question = "核对北岸水位的来源";
    const task = await send(page, question);
    expect(task.input.context?.[0]?.from).toBe(markdown.indexOf("第40段"));
    const source = await readSource(page, task, reference.document.id);
    await complete(page, task, {
      answer:
        "北岸读数已核对。\n" +
        Array.from({ length: 32 }, (_, index) => `第${index + 1}次观测的两岸水位记录一致。`).join(
          "\n",
        ),
      sourceIds: [source.source.id],
    });
    const panel = page.getByRole("region", { name: "文档 AI" });
    const link = panel.getByRole("link", { name: reference.document.path, exact: true });
    await expect(link).toBeVisible();
    // Later turns make the first answer independently scrollable.
    const later = await send(page, "补充说明");
    await complete(page, later, { answer: "第二次水位观测。\n".repeat(90) });
    await expect(panel.getByText("第二次水位观测。", { exact: false })).toBeVisible();
    const draft = panel.getByRole("textbox", { name: "提示词" });
    await draft.fill("尚未发送的追问");
    await link.focus();
    await link.scrollIntoViewIfNeeded();
    const transcriptTop = () =>
      link.evaluate((el) => {
        let parent = el.parentElement;
        while (parent && getComputedStyle(parent).overflowY !== "auto")
          parent = parent.parentElement;
        if (!parent) throw new Error("Missing transcript scroll container");
        return parent.scrollTop;
      });
    const beforeLink = await passageTop();
    const beforeTranscript = await transcriptTop();
    expect(beforeTranscript).toBeGreaterThan(32);
    await link.press("Enter");
    await expect(page.getByRole("article")).toContainText("北岸的水尺读数。");
    await page.goBack();
    await expect(page).toHaveURL(pathToNote);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(question, { exact: true })).toBeVisible();
    await expect(link).toBeFocused();
    await expect(draft).toHaveValue("尚未发送的追问");
    await expect
      .poll(async () => Math.abs((await transcriptTop()) - beforeTranscript))
      .toBeLessThan(3);
    await expect.poll(async () => Math.abs((await passageTop()) - beforeLink)).toBeLessThan(3);
    await test
      .info()
      .attach("returned-to-answer", { body: await page.screenshot(), contentType: "image/png" });
    await test.info().attach("source-return-position", {
      contentType: "application/json",
      body: JSON.stringify(
        {
          viewport: page.viewportSize(),
          source: source.source.path,
          runner: "fixture",
          passageTopBeforeOpening: beforeOpening,
          passageTopBeforeLeaving: beforeLink,
          passageTopAfterReturn: await passageTop(),
          transcriptScrollBeforeLeaving: beforeTranscript,
          transcriptScrollAfterReturn: await transcriptTop(),
          focused: await link.evaluate((el) => el.ownerDocument.activeElement === el),
          draft: await draft.inputValue(),
        },
        null,
        2,
      ),
    });
    const followup = await send(page, "继续核对所选段落");
    expect(followup.input.context).toEqual(task.input.context);
    await complete(page, followup, { answer: "核对完毕。" });
    await draft.press("Escape");
    await expect(panel).toBeHidden();
    await expect.poll(async () => Math.abs((await passageTop()) - beforeOpening)).toBeLessThan(3);
  });
}

test("follows a citation to a passage in the current document and returns with Back", async ({
  page,
}) => {
  const markdown = Array.from({ length: 90 }, (_, i) => `观测笔记第${i + 1}段。`).join("\n\n");
  const { document, pathToNote, apiUrl, origin } = await createNote(page, "原文定位.md", markdown);
  const paragraph = page.getByRole("article").getByText("观测笔记第65段。", { exact: true });
  await paragraph.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
    const range = new Range();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await openDocumentTool(page, "AI");
  const task = await send(page, "核对这段");
  const source = await readSource(page, task, document.document.id);
  expect(source.markdown).toBe("观测笔记第65段。");
  await complete(page, task, { answer: "来源是原文第65段。", sourceIds: [source.source.id] });
  const link = page.getByRole("list", { name: "引用来源" }).getByRole("link");
  await page.getByRole("main").evaluate((el) => {
    el.scrollTop = 0;
  });
  await link.click();
  await expect(paragraph).toBeInViewport();
  await expect(paragraph).toBeFocused();
  await openDocumentTool(page, "AI");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(link).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(pathToNote);
  await expect(link).toBeFocused();

  const href = await link.getAttribute("href");
  if (!href) throw new Error("Missing passage link");
  const changed = await page.request.put(apiUrl, {
    headers: { origin },
    data: { baseRevision: document.revision, markdown: "观测记录已重新编排。" },
  });
  expect(changed.ok()).toBe(true);
  await page.goto(href);
  await page.reload();
  await expect(page.getByRole("article")).toContainText("观测记录已重新编排。");
  await expect(page.getByRole("status").filter({ hasText: "引用时的正文已更新" })).toBeVisible();
});

test("a read-only member returns from an unavailable source to the original answer", async ({
  page,
}) => {
  const { document, pathToNote, origin } = await createNote(
    page,
    "来源已移除.md",
    "原问题仍然保留。",
    "另一空间",
  );
  const reference = await addNote(
    page,
    document.document.workspaceId,
    "旧记录.md",
    "旧记录的内容。",
  );
  await page.context().clearCookies();
  const login = await page.request.post("/.auth/librarian/login", {
    headers: { origin },
    form: {
      username: "offline-reader",
      password: "offline-reader-test-password",
    },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  await page.reload();
  await openDocumentTool(page, "AI");
  await expect(page.getByRole("button", { name: "修改", exact: true })).toHaveCount(0);
  const task = await send(page, "看旧记录");
  const source = await readSource(page, task, reference.document.id);
  await complete(page, task, { answer: "记录保存在旧文件。", sourceIds: [source.source.id] });
  await page.route(`**/api/v1/documents/${reference.document.id}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "not_found", message: "Missing document" }),
    }),
  );
  const link = page.getByRole("link", { name: reference.document.path, exact: true });
  await link.click();
  await expect(page.getByRole("alert")).toContainText("此文档不存在");
  await page.goBack();
  await expect(page).toHaveURL(pathToNote);
  await expect(link).toBeFocused();
  await expect(page.getByText("记录保存在旧文件。")).toBeVisible();
});

test("keeps the live editor selection as AI context after focus exits", async ({ page }) => {
  const markdown = "正文前缀。片段甲乙。结束。\n";
  const { document } = await createNote(page, "AiEditorSelection.md", markdown);
  await page.getByRole("article").getByText("正文前缀。片段甲乙。结束。").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+Home");
  const from = markdown.indexOf("片段甲乙");
  for (let index = 0; index < from; index++) await page.keyboard.press("ArrowRight");
  for (let index = 0; index < 4; index++) await page.keyboard.press("Shift+ArrowRight");
  await openDocumentTool(page, "AI");
  await expect(page.getByRole("article")).toBeVisible();
  const task = await send(page, "解释这段编辑选区");
  expect(task.input.context).toEqual([
    {
      documentId: document.document.id,
      revision: document.revision,
      from,
      to: from + 4,
      blockId: null,
    },
  ]);
  const source = await readSource(page, task, document.document.id);
  expect(source.markdown).toBe("片段甲乙");
  await complete(page, task, { answer: "已读取编辑选区", sourceIds: [source.source.id] });
});

test("AI commits preserve the active local draft and expose diff and undo", async ({ page }) => {
  const { apiUrl, document } = await createNote(page, "AiDirty.md", "共同原件\n");
  const second = await addNote(page, document.document.workspaceId, "AiCompanion.md", "旁注\n");
  await openDocumentTool(page, "AI");
  const task = await send(page, "修订正文和旁注", true);
  const bodySource = await readSource(page, task, document.document.id);
  await readSource(page, task, second.document.id);
  let releaseSave = () => {};
  const held = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(`**${apiUrl}`, async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.continue();
  });
  await page.getByRole("article").getByText("共同原件").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+End");
  await page.keyboard.insertText("本地草稿");
  try {
    await complete(page, task, {
      answer: "修订完成",
      sourceIds: [bodySource.source.id],
      edits: [
        { path: document.document.path, baseRevision: document.revision, markdown: "远程改动\n" },
        { path: second.document.path, baseRevision: second.revision, markdown: "旁注已修订\n" },
      ],
    });
  } finally {
    releaseSave();
  }
  await expect(page.getByText("已修改 2 个文件")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("服务器上的正文已更新");
  await expect(editor).toContainText("本地草稿");
  expect(((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown).toBe(
    "远程改动\n",
  );

  await page.getByRole("button", { name: "查看改动" }).click();
  const changes = page.getByRole("region", { name: "AI 改动" });
  await expect(changes).toContainText("AiDirty.md");
  await expect(changes).toContainText("AiCompanion.md");
  await changes.getByRole("button", { name: "AiDirty.md" }).click();
  await expect(changes.getByLabel("版本差异")).toContainText("+远程改动");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByText("已撤销并保存为新版本")).toBeVisible();
  await expect(page.getByRole("article")).toContainText("本地草稿");
  await page.keyboard.press("Alt+e");
  await expect(editor).toContainText("本地草稿");
  expect(((await (await page.request.get(apiUrl)).json()) as DocumentSnapshot).markdown).toBe(
    "共同原件\n",
  );
});

test("context falls back to the active semantic block and outline stays independent", async ({
  page,
}) => {
  const markdown = "# 河口\n\n水位持续上涨。\n\n岸边还有白鹭。\n";
  const { document, apiUrl, origin } = await createNote(page, "AiSemantic.md", markdown);
  const saved = await page.request.put(`${apiUrl}/outline`, {
    headers: { origin },
    data: { markdown: "检查水位与鸟类。", baseRevision: null },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  const article = page.getByRole("article");
  await article.focus();
  await article.press("]");
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeVisible();
  await openDocumentTool(page, "AI");
  const task = await send(page, "总结当前聚焦段落");
  const selected = await readSource(page, task, document.document.id);
  expect(selected.markdown).toBe("# 河口\n\n水位持续上涨。");
  expect(selected.source.blockId).toContain("heading");
  const outline = await readSource(page, task, document.document.id, true);
  expect(outline.markdown).toBe("检查水位与鸟类。");
  await complete(page, task, {
    answer: "水位持续上涨",
    sourceIds: [selected.source.id, outline.source.id],
  });
  await expect(page.getByRole("list", { name: "引用来源" })).toContainText("AiSemantic.outline.md");
  const outlineSource = page.getByRole("link", { name: "AiSemantic.outline.md", exact: true });
  await outlineSource.click();
  await expect(page.getByRole("tab", { name: "提纲", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "Markdown 提纲" })).toBeVisible();
  await page.goBack();
  await expect(outlineSource).toBeFocused();
  await openDocumentTool(page, "提纲");
  await expect(page.getByRole("textbox", { name: "Markdown 提纲" })).toContainText(
    "检查水位与鸟类。",
  );
  await openDocumentTool(page, "AI");
  await expect(page.getByRole("region", { name: "文档 AI" })).toContainText("水位持续上涨");
  await expect(page.getByRole("group", { name: "语义聚焦" })).toBeVisible();
});

test("Workspace AI stays in a separate route and resumes an interrupted event replay", async ({
  page,
}) => {
  const { document, pathToNote } = await createNote(page, "AiWorkspace.md", "空间问答的来源。");
  await page.getByRole("button", { name: "搜索文档" }).click();
  await page.getByRole("option", { name: "工作区 AI", exact: true }).click();
  await expect(page).toHaveURL(`/workspaces/${document.document.workspaceId}/ai`);
  await expect(page.getByRole("heading", { name: "工作区 AI" })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开文档辅助区" })).toHaveCount(0);

  const cursors: number[] = [];
  let abortNext = false;
  let interrupted: number | undefined;
  await page.route("**/ai/operations/*/events", async (route) => {
    const cursor = Number(route.request().headers()["last-event-id"]);
    cursors.push(cursor);
    if (abortNext && cursor > 0) {
      abortNext = false;
      interrupted = cursor;
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  const task = await send(page, "询问整个空间");
  expect(task.input.documentId).toBeNull();
  expect(task.input.context).toEqual([]);
  const eventUrl = `${runner}/${task.leaseId}/events`;
  const delta = { executorSeq: 1, kind: "text_delta", text: "重连前的文字" };
  expect((await page.request.post(eventUrl, { headers, data: delta })).ok()).toBe(true);
  await expect(page.getByText("重连前的文字", { exact: true })).toBeVisible();
  abortNext = true;
  await expect.poll(() => interrupted).toBeGreaterThan(0);
  expect((await page.request.post(eventUrl, { headers, data: delta })).ok()).toBe(true);
  expect(
    (
      await page.request.post(eventUrl, {
        headers,
        data: { ...delta, executorSeq: 2, text: "，重连后的文字" },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.getByText("重连前的文字，重连后的文字", { exact: true })).toHaveCount(1);
  expect(cursors.slice(-2)).toEqual([interrupted, interrupted]);

  await complete(page, task, { answer: "空间任务已完成" });
  await expect(page.getByText("空间任务已完成", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("空间任务已完成", { exact: true })).toBeVisible();
  await expect(page.getByText("询问整个空间", { exact: true })).toBeVisible();
  await page.goto(pathToNote);
  await openDocumentTool(page, "AI");
  await expect(page.getByText("空间任务已完成", { exact: true })).toHaveCount(0);
});

test("AI destructive change awaits confirmation and shows the deleted file diff", async ({
  page,
}) => {
  const { document } = await createNote(page, "AiConfirm.md", "仍保留的文档。\n");
  const deleted = await addNote(
    page,
    document.document.workspaceId,
    "AiDelete.md",
    "请确认后删除这行。\n",
  );
  await openDocumentTool(page, "AI");
  const task = await send(page, "删除过期文档", true);
  const source = await readSource(page, task, deleted.document.id);
  await complete(page, task, {
    answer: "发现过期文档",
    sourceIds: [source.source.id],
    edits: [{ path: deleted.document.path, baseRevision: deleted.revision, markdown: null }],
  });
  const confirmation = page.getByRole("region", { name: "待确认的操作" });
  await expect(confirmation).toContainText("AiDelete.md");
  await expect(page.getByText("已修改 1 个文件")).toHaveCount(0);
  await confirmation.getByRole("button", { name: "确认操作" }).click();
  await expect(page.getByText("已修改 1 个文件")).toBeVisible();
  await page.getByRole("button", { name: "查看改动" }).click();
  await page.getByRole("button", { name: "AiDelete.md" }).click();
  await expect(page.getByLabel("版本差异")).toContainText("-请确认后删除这行。");
});

test("an AI commit refreshes the clean reader, and undo is available after reload", async ({
  page,
}) => {
  const { document } = await createNote(page, "AiClean.md", "# 礁石\n\n确认之前的记载。\n");
  await openDocumentTool(page, "AI");
  const task = await send(page, "更新这份记录", true);
  const original = await readSource(page, task, document.document.id);
  await complete(page, task, {
    answer: "记录已更新",
    sourceIds: [original.source.id],
    edits: [
      {
        path: document.document.path,
        baseRevision: document.revision,
        markdown: "# 礁石\n\n确认之后的记载。\n",
      },
    ],
  });
  const article = page.getByRole("article");
  await expect(article).toContainText("确认之后的记载。");
  await page.reload();
  await openDocumentTool(page, "AI");
  await expect(page.getByText("记录已更新", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(article).toContainText("确认之前的记载。");
});
