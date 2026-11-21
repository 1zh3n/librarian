import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, DocumentSummary, Workspace } from "../../src/api/client";

export async function openDocumentTool(
  page: Page,
  name: "提纲" | "AI" | "版本" | "引用" | "文档目录",
) {
  if (name === "文档目录") {
    await page.getByRole("button", { name: "文档更多" }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    return;
  }
  const open = page.getByRole("button", { name: "打开文档辅助区" });
  const tabs = page.getByRole("tablist", { name: "文档工具" });
  await open.or(tabs).first().waitFor({ state: "visible" });
  if (await open.isVisible()) await open.click();
  await tabs.getByRole("tab", { name, exact: true }).click();
}

export async function closeDocumentTool(page: Page) {
  await page.getByRole("button", { name: "收起文档辅助区" }).click();
}

export async function signIn(page: Page, username: string, password: string) {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const result = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/.auth/librarian/login"),
  );
  await page.getByRole("button", { name: "登录" }).click();
  expect((await result).status()).toBe(303);
}

export async function openFieldWorkspace(page: Page, name = "田野笔记") {
  await signIn(page, "reader", "reader-test-password");
  const response = await page.request.get("/api/v1/workspaces");
  expect(response.ok()).toBe(true);
  const workspaces = (await response.json()) as Workspace[];
  const workspace = workspaces.find((item) => item.name === name);
  if (!workspace) throw new Error("Missing test Space");
  return workspace;
}

export async function fieldDocument(page: Page, path = "野外/01.md") {
  const workspace = await openFieldWorkspace(page);
  const endpoint = `/api/v1/workspaces/${workspace.id}/documents`;
  const limit = 100;
  const params = new URLSearchParams({ limit: String(limit) });
  for (;;) {
    const response = await page.request.get(endpoint, { params });
    expect(response.ok()).toBe(true);
    const batch = (await response.json()) as DocumentSummary[];
    const document = batch.find((item) => item.path === path);
    if (document) return `/workspaces/${workspace.id}/documents/${document.id}`;
    const last = batch.at(-1);
    if (batch.length < limit || !last) throw new Error(`Missing fixture document: ${path}`);
    params.set("after", last.path);
  }
}

export async function createNote(
  page: Page,
  path: string,
  markdown: string,
  workspaceName?: string,
) {
  const workspace = await openFieldWorkspace(page, workspaceName);
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(`/api/v1/workspaces/${workspace.id}/documents`, {
    headers: { origin },
    data: { path, markdown, baseRevision: null },
  });
  expect(response.status()).toBe(201);
  const document = (await response.json()) as DocumentSnapshot;
  const apiUrl = `/api/v1/documents/${document.document.id}`;
  const pathToNote = `/workspaces/${workspace.id}/documents/${document.document.id}`;
  await page.goto(pathToNote);
  return { document, pathToNote, apiUrl, origin };
}
