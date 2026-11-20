import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, Workspace } from "../../src/api/client";

export async function openFieldWorkspace(page: Page, name = "田野笔记") {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("reader");
  await page.getByLabel("密码").fill("reader-test-password");
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
    ),
    page.getByRole("button", { name: "登录" }).click(),
  ]);
  expect(login.status()).toBe(303);
  const response = await page.request.get("/api/v1/workspaces");
  expect(response.ok()).toBe(true);
  const workspaces = (await response.json()) as Workspace[];
  const workspace = workspaces.find((item) => item.name === name);
  if (!workspace) throw new Error("Missing test Space");
  return workspace;
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
