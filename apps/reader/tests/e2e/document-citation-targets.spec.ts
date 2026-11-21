import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { AiOperation, DocumentSnapshot, OutlineSnapshot } from "../../src/api/client";
import { createNote, openDocumentTool } from "./productFixture";

test.use({ serviceWorkers: "block" });

type Source = AiOperation["sources"][number];

async function openRecordedAnswer(page: Page, note: DocumentSnapshot, sources: Source[]) {
  const operation: AiOperation = {
    id: crypto.randomUUID(),
    workspaceId: note.document.workspaceId,
    documentId: note.document.id,
    mode: "chat",
    status: "succeeded",
    answer: "请核对引文。",
    sources,
    commitId: null,
    confirmation: null,
    undoCommitId: null,
    changes: [],
  };
  // Seed only the answer. The Reader generates and follows the actual source links.
  await page.route("**/api/v1/ai/operations?**", (route) => route.fulfill({ json: [operation] }));
  await page.reload();
  await openDocumentTool(page, "AI");
  return page.getByRole("list", { name: "引用来源" });
}

function bodySource(note: DocumentSnapshot): Source {
  return {
    id: crypto.randomUUID(),
    documentId: note.document.id,
    path: note.document.path,
    revision: note.revision,
  };
}

async function refetchWithStatus(page: Page, path: string, status: number) {
  await page.route(`**${path}`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status,
      json: { code: "fixture_error", message: "Fixture response" },
    });
  });
  await page.clock.fastForward(21_000);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" && new URL(r.url()).pathname === path && r.status() === status,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await response;
}

for (const status of [401, 403, 404]) {
  test(`a document refetch returning ${status} withdraws the previously rendered note`, async ({
    page,
  }) => {
    const { apiUrl } = await createNote(page, `文档状态-${status}.md`, "先前打开的正文。");
    const article = page.getByRole("article");
    await expect(article).toContainText("先前打开的正文。");
    await page.clock.install();
    await refetchWithStatus(page, apiUrl, status);
    await expect(article).toHaveCount(0);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "文档更多" })).toHaveCount(0);
  });
}

test("a temporary failed refresh keeps the current editor and its draft", async ({ page }) => {
  const { apiUrl } = await createNote(page, "文档临时失败.md", "临时断线前。");
  await page.getByRole("article").press("Alt+Shift+e");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+End");
  await page.clock.install();
  // Block only the automatic write while simulating the failed background read.
  await page.route(`**${apiUrl}`, (route) =>
    route.request().method() === "PUT" ? route.abort() : route.fallback(),
  );
  await page.keyboard.insertText("草稿。");
  await refetchWithStatus(page, apiUrl, 503);
  await expect(editor).toContainText("草稿。");
});

test("a refused outline refresh hides the cached sidecar while its document remains readable", async ({
  page,
}) => {
  const { apiUrl, origin } = await createNote(page, "提纲拒绝.md", "仍可阅读正文。");
  const path = `${apiUrl}/outline`;
  expect(
    (
      await page.request.put(path, {
        headers: { origin },
        data: { markdown: "提纲缓存。", baseRevision: null },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await openDocumentTool(page, "提纲");
  const editor = page.getByRole("textbox", { name: "Markdown 提纲" });
  await expect(editor).toContainText("提纲缓存。");
  await page.clock.install();
  await refetchWithStatus(page, path, 403);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("无法打开提纲");
  await expect(page.getByRole("article")).toContainText("仍可阅读正文。");
});

test("a whole-document source warns after its cited revision changes", async ({ page }) => {
  const { document: reader, origin } = await createNote(page, "核对整篇.md", "核对整篇记录。");
  const created = await page.request.post(
    `/api/v1/workspaces/${reader.document.workspaceId}/documents`,
    {
      headers: { origin },
      data: { path: "整篇来源.md", markdown: "旧的整篇记录。", baseRevision: null },
    },
  );
  expect(created.status()).toBe(201);
  const reference = (await created.json()) as DocumentSnapshot;
  const answer = await openRecordedAnswer(page, reader, [bodySource(reference)]);
  expect(
    (
      await page.request.put(`/api/v1/documents/${reference.document.id}`, {
        headers: { origin },
        data: { markdown: "更新后的整篇记录。", baseRevision: reference.revision },
      })
    ).ok(),
  ).toBe(true);
  await answer.getByRole("link").click();
  await expect(page.getByRole("article")).toContainText("更新后的整篇记录。");
  await expect(page.getByRole("status").filter({ hasText: "引用时的正文已更新" })).toBeVisible();
  await expect(page.getByRole("article")).toBeFocused();
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("revision")).toBe(
    reference.revision,
  );
});

test("an outline source compares the sidecar revision independently of the body", async ({
  page,
}) => {
  const { document: note, apiUrl, origin } = await createNote(page, "提纲版本.md", "正文初稿。");
  const path = `${apiUrl}/outline`;
  const seeded = await page.request.put(path, {
    headers: { origin },
    data: { markdown: "第一版提纲。", baseRevision: null },
  });
  expect(seeded.ok()).toBe(true);
  const outline = (await seeded.json()) as OutlineSnapshot;
  expect(outline.revision).toBeTruthy();
  const answer = await openRecordedAnswer(page, note, [
    {
      ...bodySource(note),
      path: "提纲版本.outline.md",
      revision: outline.revision!,
    },
  ]);
  const link = answer.getByRole("link");
  const href = (await link.getAttribute("href"))!;
  await link.click();
  const editor = page.getByRole("textbox", { name: "Markdown 提纲" });
  await expect(editor).toContainText("第一版提纲。");
  await expect(page.getByText(/引用时的.*已更新/)).toHaveCount(0);
  expect(
    (
      await page.request.put(path, {
        headers: { origin },
        data: { markdown: "第二版提纲。", baseRevision: outline.revision },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(editor).toContainText("第二版提纲。");
  await expect(page.getByRole("status").filter({ hasText: "引用时的提纲已更新" })).toBeVisible();
  expect(new URLSearchParams(href.split("?")[1]).get("revision")).toBe(outline.revision);
});

test("an outline citation checks the sidecar even when the open document has no outline flag", async ({
  page,
}) => {
  const { document: note, apiUrl, origin } = await createNote(page, "提纲新增.md", "正文。");
  expect(note.document.outlineEnabled).toBe(false);
  const answer = await openRecordedAnswer(page, note, [
    { ...bodySource(note), path: "提纲新增.outline.md" },
  ]);
  const link = answer.getByRole("link");
  await expect(link).toBeVisible();
  const path = `${apiUrl}/outline`;
  const saved = await page.request.put(path, {
    headers: { origin },
    data: { markdown: "另一成员新增的提纲。", baseRevision: null },
  });
  expect(saved.ok()).toBe(true);
  await link.click();
  await expect(page.getByRole("textbox", { name: "Markdown 提纲" })).toContainText(
    "另一成员新增的提纲。",
  );
  await expect(page.getByText("引用的提纲已移除。")).toHaveCount(0);
});

test("a missing cited sidecar reports its removal without opening a blank editor", async ({
  page,
}) => {
  const { document: note, apiUrl } = await createNote(page, "提纲已移除.md", "正文仍存在。");
  const answer = await openRecordedAnswer(page, note, [
    { ...bodySource(note), path: "提纲已移除.outline.md" },
  ]);
  const getOutline = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `${apiUrl}/outline`,
    { timeout: 5000 },
  );
  const [response] = await Promise.all([getOutline, answer.getByRole("link").click()]);
  expect((await response.json()).revision).toBeNull();
  await expect(page.getByRole("status").filter({ hasText: "引用的提纲已移除" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown 提纲" })).toHaveCount(0);
  await expect(page.getByRole("article")).toContainText("正文仍存在。");
});

for (const composing of [false, true]) {
  test(`full source focuses the cited block in the same document${composing ? " after composition ends" : ""}`, async ({
    page,
  }) => {
    const passage = "第65站的晨间记录。";
    const markdown = Array.from({ length: 90 }, (_, i) => `第${i + 1}站的晨间记录。`).join("\n\n");
    const { document: note } = await createNote(
      page,
      composing ? "输入法源码定位.md" : "完整源码定位.md",
      markdown,
    );
    const from = markdown.indexOf(passage);
    const answer = await openRecordedAnswer(page, note, [
      { ...bodySource(note), from, to: from + passage.length },
    ]);
    await page.getByRole("article").press("Alt+Shift+e");
    const editor = page.getByRole("textbox", { name: "Markdown 正文" });
    await expect(editor).toBeFocused();
    await editor.press("Control+Home");
    if (composing) await editor.dispatchEvent("compositionstart");
    await answer.getByRole("link").click();
    if (composing) {
      await expect(page).toHaveURL(/#reader-source\?/u);
      await expect(editor).toBeVisible();
      await editor.dispatchEvent("compositionend");
    }
    const target = page.getByRole("article").getByText(passage, { exact: true });
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport({ ratio: 1 });
  });
}
