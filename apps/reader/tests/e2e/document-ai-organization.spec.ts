import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { components } from "../../src/api/schema.gen";
import { openFieldWorkspace } from "./productFixture";

type Workspace = components["schemas"]["Workspace"];
type DocumentSnapshot = components["schemas"]["DocumentSnapshot"];
type Result = components["schemas"]["AiManagedResult"];
const claims = "/api/v1/ai/runner/claims";
const runner = { authorization: "Bearer reader-fixture-ai-token-only-for-tests" };

async function setup(page: Page, name: string) {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const response = await page.request.post("/api/v1/workspaces", { headers, data: { name } });
  expect(response.status()).toBe(201);
  const ws = (await response.json()) as Workspace;
  const add = async (path: string, markdown: string) => {
    const created = await page.request.post(`/api/v1/workspaces/${ws.id}/documents`, {
      headers,
      data: { path, baseRevision: null, markdown },
    });
    expect(created.status()).toBe(201);
    return (await created.json()) as DocumentSnapshot;
  };
  const note = await add("记录/笔记.md", "# 原始笔记\r\n");
  await add("项目/方案.md", "[笔记](../记录/笔记.md)\n");
  await page.goto(`/workspaces/${ws.id}/ai`);
  await expect(page.getByRole("heading", { name: name + " · 工作区 AI" })).toBeVisible();
  return { ws, note };
}

async function edit(page: Page, prompt: string, note: DocumentSnapshot, outcome: Result) {
  const form = page.getByRole("form", { name: "AI 请求" });
  await form.getByRole("textbox", { name: "提示词" }).fill(prompt);
  const queued = page.waitForResponse(
    (r) => r.url().endsWith("/turns") && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: /发送模式/ }).click();
  await page.getByRole("option", { name: "修改", exact: true }).click();
  await form.getByRole("button", { name: "发送", exact: true }).click();
  expect((await queued).status()).toBe(202);
  const claimed = await page.request.post(claims, { headers: runner });
  expect(claimed.status()).toBe(200);
  const task = (await claimed.json()) as { leaseId: string };
  const source = await page.request.post(`${claims}/${task.leaseId}/sources`, {
    headers: runner,
    data: { documentId: note.document.id },
  });
  expect(source.status()).toBe(200);
  const result = await page.request.put(`${claims}/${task.leaseId}/result`, {
    headers: runner,
    data: outcome,
  });
  expect(result.status(), await result.text()).toBe(200);
}

test("workspace batch receipt links to the created document and reverses the exact update", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { note, ws } = await setup(page, "索引试验");
  await edit(page, "汇总工作区", note, {
    answer: "已生成索引。",
    edits: [
      { path: "索引.md", baseRevision: null, markdown: "# 索引\n" },
      { documentId: note.document.id, baseRevision: note.revision, markdown: "新记录\n" },
    ],
  });
  const receipt = page.getByRole("region", { name: "操作回执" });
  await expect(receipt).toHaveText(/新建 1 个文件，更新 1 个文件/);
  await expect(
    page.getByRole("list", { name: "引用来源" }).getByRole("link", { name: "记录/笔记.md" }),
  ).toBeVisible();
  const created = receipt.getByRole("link", { name: "索引.md", exact: true });
  await expect(created).toHaveAttribute("href", new RegExp(`/workspaces/${ws.id}/documents/doc_`));
  await info.attach("批量回执", { body: await page.screenshot(), contentType: "image/png" });
  await created.click();
  await expect(page.getByRole("article")).toContainText("索引");
  await page.goBack();
  await receipt.getByRole("button", { name: "查看改动" }).click();
  await receipt.getByRole("button", { name: "记录/笔记.md" }).click();
  await expect(receipt.getByLabel("版本差异")).toContainText("新记录");
  await receipt.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(receipt.getByText("已撤销并保存为新版本")).toBeVisible();
  const restored = await page.request.get(`/api/v1/documents/${note.document.id}`);
  expect((await restored.json()).markdown).toBe(note.markdown);
});

test("review a directory move on a narrow screen, cancel by keyboard and confirm a fresh plan", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { note } = await setup(page, "归档试验");
  const result: Result = {
    answer: "请核对目录移动。",
    reorganization: { kind: "move", from: "记录", to: "归档/记录" },
  };
  await edit(page, "移动记录目录", note, result);
  const plan = page.getByRole("region", { name: "待确认的操作" });
  await expect(plan.getByText("记录 → 归档/记录", { exact: true })).toBeVisible();
  await expect(plan.getByRole("list", { name: "受影响的内链" })).toContainText("项目/方案.md");
  await info.attach("移动预览", { body: await page.screenshot(), contentType: "image/png" });
  const cancel = plan.getByRole("button", { name: "取消操作" });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(plan).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "提示词" })).toBeFocused();
  await edit(page, "确认归档", note, result);
  await plan.getByRole("button", { name: "确认移动" }).click();
  const receipt = page.getByRole("region", { name: "操作回执" });
  await expect(receipt).toContainText("归档/记录/笔记.md");
  await receipt.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(receipt.getByText("已撤销并保存为新版本")).toBeVisible();
  const restored = await page.request.get(`/api/v1/documents/${note.document.id}`);
  expect((await restored.json()).document.path).toBe("记录/笔记.md");
});

test("a Reader confirmation link opens only the requested workspace operation", async ({
  page,
}) => {
  const { note, ws } = await setup(page, "外部操作确认");
  const headers = { origin: new URL(page.url()).origin };
  const response = await page.request.post("/api/v1/ai/operations", {
    headers,
    data: { workspaceId: ws.id, mode: "edit", prompt: "删除指定文档" },
  });
  expect(response.status()).toBe(202);
  const op = (await response.json()) as { id: string };
  const claim = await page.request.post(claims, { headers: runner });
  const lease = (await claim.json()) as { leaseId: string };
  const preview = await page.request.put(`${claims}/${lease.leaseId}/result`, {
    headers: runner,
    data: {
      answer: "等待确认",
      reorganization: { kind: "delete", documentIds: [note.document.id] },
    },
  });
  expect(preview.status()).toBe(200);
  await page.goto(`/workspaces/${ws.id}/ai?operationId=${op.id}`);
  const focused = page.getByRole("region", { name: "指定操作" });
  await expect(focused.getByRole("button", { name: "确认删除" })).toBeVisible();
  await focused.getByRole("button", { name: "取消操作" }).click();
  await expect(focused.getByText("此操作已取消。")).toBeVisible();
  await expect(focused.getByRole("link", { name: "返回工作区 AI" })).toBeFocused();
});
