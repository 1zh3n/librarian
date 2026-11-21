import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { AiOperation, AiTask, DocumentSnapshot } from "../../src/api/client";
import { closeDocumentTool, createNote, openDocumentTool } from "./productFixture";

const original = "原来的观测笔记。\n";
const answer = "请核对这份观测记录。";

async function openAnswer(page: Page, title: string, sameDocument = false) {
  const note = await createNote(page, `野外/${title}.md`, original);
  const { id, workspaceId } = note.document.document;
  let reference = note.document;
  if (!sameDocument) {
    const result = await page.request.post(`/api/v1/workspaces/${workspaceId}/documents`, {
      headers: { origin: note.origin },
      data: { path: `${title}-来源.md`, markdown: "引文里的水尺读数。", baseRevision: null },
    });
    expect(result.status()).toBe(201);
    reference = (await result.json()) as DocumentSnapshot;
  }

  // Supply one completed turn without competing with the runner's shared claim queue.
  const operation: AiOperation = {
    id: "observation",
    workspaceId,
    documentId: id,
    mode: "chat",
    status: "succeeded",
    answer,
    sources: [
      {
        id: "citation",
        path: reference.document.path,
        documentId: reference.document.id,
        revision: reference.revision,
        ...(sameDocument && { from: 0, to: original.trimEnd().length }),
      },
    ],
    changes: [],
    commitId: null,
    undoCommitId: null,
    confirmation: null,
  };
  await page.route(
    (url) => url.pathname === "/api/v1/ai/operations" && url.searchParams.get("documentId") === id,
    (route) => route.fulfill({ json: [operation] }),
  );
  await openDocumentTool(page, "AI");
  const panel = page.getByRole("region", { name: "文档 AI" });
  const link = panel.getByRole("link", { name: reference.document.path, exact: true });
  await expect(link).toBeVisible();
  return {
    ...note,
    panel,
    link,
    prompt: panel.getByRole("textbox", { name: "提示词" }),
    reference,
    operation,
  };
}

async function enterSourceEditor(page: Page) {
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "完整源码" }).click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+Home");
  return editor;
}

async function directoryRoundTrip(page: Page, originPath: string) {
  await page.getByRole("row", { name: "林间回声", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("清晨听见鸟鸣。");
  await page.goBack();
  await expect(page).toHaveURL(originPath);
  await expect(page.getByRole("article")).toContainText("原来的观测笔记。");
}

test("canceling a citation does not revive the canceled draft after later directory navigation", async ({
  page,
}) => {
  const note = await openAnswer(page, "取消核对");
  const obsolete = "取消核对前的追问";
  await note.prompt.fill(obsolete);
  await page.route(note.apiUrl, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { code: "unavailable", message: "稍后重试" } })
      : route.continue(),
  );
  await enterSourceEditor(page);
  await page.keyboard.insertText("待保存。");
  const cancel = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([cancel, note.link.click()]);
  await expect(page).toHaveURL(note.pathToNote);
  await expect(note.prompt).toHaveValue(obsolete);
  await note.prompt.fill("已改写的追问");
  await page.unroute(note.apiUrl);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();

  await directoryRoundTrip(page, note.pathToNote);
  await openDocumentTool(page, "AI");
  await expect(note.prompt).not.toHaveValue(obsolete);
});

test("closing a restored answer stays closed after an unrelated directory round trip", async ({
  page,
}) => {
  const note = await openAnswer(page, "结束核对");
  await note.link.click();
  await expect(page.getByRole("article")).toContainText(note.reference.markdown);
  await page.goBack();
  await expect(note.link).toBeFocused();
  await closeDocumentTool(page);
  await expect(note.panel).toBeHidden();
  await directoryRoundTrip(page, note.pathToNote);
  await expect(page.getByRole("button", { name: "打开文档辅助区" })).toBeVisible();
  await expect(note.panel).toBeHidden();
});

test("Back through source and workspace settings restores the originating answer and draft", async ({
  page,
}) => {
  const note = await openAnswer(page, "途经设置");
  await note.prompt.fill("返回后继续核对");
  await note.link.press("Enter");
  await expect(page.getByRole("article")).toContainText(note.reference.markdown);
  const sourceUrl = page.url();
  await page.getByRole("button", { name: "空间设置", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "空间设置" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(sourceUrl);
  await expect(page.getByRole("article")).toContainText(note.reference.markdown);
  await page.goBack();
  await expect(page).toHaveURL(note.pathToNote);
  await expect(note.link).toBeFocused();
  await expect(note.panel.getByText(answer, { exact: true })).toBeVisible();
  await expect(note.prompt).toHaveValue("返回后继续核对");
});

test("two history entries for the same document keep independently edited AI drafts", async ({
  page,
}) => {
  const note = await openAnswer(page, "同篇核对", true);
  await note.prompt.fill("原回答上的追问");
  await note.link.click();
  await expect(
    page.getByRole("article").getByText(original.trimEnd(), { exact: true }),
  ).toBeFocused();
  const citationUrl = page.url();
  await openDocumentTool(page, "AI");
  await expect.soft(note.prompt).toHaveValue("");
  await note.prompt.fill("来源条目上的追问");
  await page.goBack();
  await expect(page).toHaveURL(note.pathToNote);
  await expect(note.link).toBeFocused();
  await expect(note.prompt).toHaveValue("原回答上的追问");
  await note.prompt.fill("返回后改写的原追问");
  await page.goForward();
  await expect(page).toHaveURL(citationUrl);
  await openDocumentTool(page, "AI");
  await expect(note.prompt).toHaveValue("来源条目上的追问");
  await note.link.click();
  await expect(
    page.getByRole("article").getByText(original.trimEnd(), { exact: true }),
  ).toBeFocused();
  await page.goBack();
  await expect(note.link).toBeFocused();
  await expect(note.prompt).toHaveValue("来源条目上的追问");
  await page.goBack();
  await expect(note.prompt).toHaveValue("返回后改写的原追问");
});

test("the follow-up uses the selected text and revision saved while leaving for a citation", async ({
  page,
}) => {
  await checkFollowupAfterSave(page, "临行保存", false);
});

test("Back from a same-document citation keeps the selection whose save was pending", async ({
  page,
}) => {
  await checkFollowupAfterSave(page, "同篇保存", true);
});

test("a same-document citation opens during composition and Back keeps a pending edit selection", async ({
  page,
}) => {
  await checkFollowupAfterSave(page, "输入法同篇保存", true, true);
});

async function checkFollowupAfterSave(
  page: Page,
  title: string,
  sameDocument: boolean,
  composing = false,
) {
  const note = await openAnswer(page, `${title}-${crypto.randomUUID()}`, sameDocument);
  const destination = await note.link.getAttribute("href");
  if (!destination) throw new Error("Missing citation destination");
  const selected = "新选区";
  const saving = page.waitForRequest(
    (req) => req.method() === "PUT" && new URL(req.url()).pathname === note.apiUrl,
  );
  let releaseSave!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const saved = page.waitForResponse(
    (res) => res.request().method() === "PUT" && new URL(res.url()).pathname === note.apiUrl,
  );
  await page.route(note.apiUrl, async (route) => {
    if (route.request().method() === "PUT") {
      await held;
    }
    await route.continue();
  });
  try {
    const editor = await enterSourceEditor(page);
    await page.keyboard.insertText(selected);
    for (const _ of selected) await editor.press("Shift+ArrowLeft");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
    await saving;
    if (composing) await editor.dispatchEvent("compositionstart");
    await note.link.press("Enter");
    if (composing) {
      await expect(page).toHaveURL(destination);
      await expect(editor).toBeVisible();
      await editor.dispatchEvent("compositionend");
      await expect(page.getByRole("article")).toBeVisible();
    }
  } finally {
    releaseSave();
  }
  expect((await saved).ok()).toBe(true);
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole("article")).toContainText(note.reference.markdown);
  const result = await page.request.get(note.apiUrl);
  expect(result.ok()).toBe(true);
  const confirmed = (await result.json()) as DocumentSnapshot;
  expect(confirmed.markdown).toBe(selected + original);
  expect(confirmed.revision).not.toBe(note.document.revision);
  await page.goBack();
  await expect(note.link).toBeFocused();

  // Inspect the actual submission; only the model service's reply is a fixture.
  const postUrl = /\/api\/v1\/ai\/conversations\/[^/]+\/turns$/u;
  await page.route(postUrl, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { prompt, clientTurnId } = route.request().postDataJSON() as {
      prompt: string;
      clientTurnId: string;
    };
    return route.fulfill({
      status: 202,
      json: {
        id: "followup-turn",
        conversationId: new URL(route.request().url()).pathname.split("/").at(-2),
        clientTurnId,
        prompt,
        operationId: "followup",
        createdAt: Date.now() / 1000,
        historyTruncated: false,
        operation: { ...note.operation, id: "followup", answer: "已解释选区。", sources: [] },
      },
    });
  });
  await note.prompt.fill("继续解释刚才的选区");
  const [posted] = await Promise.all([
    page.waitForRequest(
      (req) => req.method() === "POST" && postUrl.test(new URL(req.url()).pathname),
    ),
    note.panel.getByRole("button", { name: "发送", exact: true }).click(),
  ]);
  const task = posted.postDataJSON() as AiTask;
  expect(task.context).toEqual([
    expect.objectContaining({
      documentId: note.document.document.id,
      revision: confirmed.revision,
      from: 0,
      to: selected.length,
    }),
  ]);
}
