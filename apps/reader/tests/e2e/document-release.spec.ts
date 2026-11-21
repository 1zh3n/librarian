import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  DeliveryReceipt,
  DocumentSummary,
  Publication,
  Workspace,
} from "../../src/api/client";

async function deliver(page: Page, workspace: string, id: string) {
  const base = `/api/v1/workspaces/${workspace}`;
  const response = await page.request.post(`${base}/deliveries`, {
    headers: { origin: new URL(page.url()).origin },
    data: {
      manifest: { deliveryId: id, sourceName: "发行浏览器验收" },
      files: [
        {
          path: "report.md",
          contentBase64: Buffer.from(
            `---\ntitle: 发行验收报告\nstatus: published\npublication:\n  - target: fixture-zola\n    state: published\n    slug: ${id}-report\n---\n\n交付验证。\n`,
          ).toString("base64"),
        },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const { commitId } = (await response.json()) as DeliveryReceipt;
  const list = (await (await page.request.get(`${base}/documents`)).json()) as DocumentSummary[];
  const note = list.find((document) => document.path === `deliveries/${id}/report.md`);
  if (!note) throw new Error("Release fixture Markdown was not indexed");
  return { note, commitId };
}

async function workspaceAsAdmin(page: Page, name = "田野笔记") {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("fixture-admin");
  await page.getByLabel("密码").fill("fixture-admin-test-password");
  const [login] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
    ),
    page.getByRole("button", { name: "登录" }).click(),
  ]);
  expect(login.status()).toBe(303);
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const workspace = workspaces.find((space) => space.name === name);
  if (!workspace || !workspace.canManage) throw new Error("Missing managed release fixture");
  return workspace;
}

test("configures a Workspace backup and reloads its confirmed Git receipt", async ({ page }) => {
  const workspace = await workspaceAsAdmin(page, "浏览器本地备份");
  const { commitId } = await deliver(page, workspace.id, "browser-backup");
  await page.goto(`/workspaces/${workspace.id}/manage`);

  const panel = page.getByRole("region", { name: "工作区备份" });
  await panel.getByRole("button", { name: /备份目标/ }).click();
  await page.getByRole("option", { name: "本地备份" }).click();
  await panel.getByRole("button", { name: /备份粒度/ }).click();
  await page.getByRole("option", { name: "逐操作" }).click();
  await panel.getByRole("button", { name: "保存备份设置" }).click();
  await expect(panel.getByText("备份设置已保存")).toBeVisible();
  await panel.getByRole("button", { name: "立即备份" }).click();
  await expect(panel.getByText("备份已完成")).toBeVisible();
  await expect(panel).toContainText(commitId);
  await page.reload();
  await expect(panel.getByText("备份已完成")).toBeVisible();
  await expect(panel.getByRole("button", { name: /逐操作.*备份粒度/ })).toBeVisible();
});

test("publishes the explicitly selected Git version and documents to the configured target", async ({
  page,
}) => {
  const workspace = await workspaceAsAdmin(page);
  const { note, commitId } = await deliver(page, workspace.id, "browser-publication");
  await page.goto(`/workspaces/${workspace.id}/manage`);
  const panel = page.getByRole("region", { name: "Zola 发布" });
  await panel.getByRole("button", { name: /发布目标/ }).click();
  await page.getByRole("option", { name: "本地博客" }).click();
  await panel.getByRole("textbox", { name: "Git 提交 ID" }).fill(commitId);
  await panel.getByText(note.path, { exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: note.path })).toBeChecked();

  const confirmed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/v1/publications"),
  );
  await panel.getByRole("button", { name: "确认并发布" }).click();
  const result = await confirmed;
  expect(result.status(), await result.text()).toBe(201);
  expect(result.request().postDataJSON()).toMatchObject({
    confirm: true,
    documentIds: [note.id],
    commitId,
    targetId: "fixture-zola",
  });
  await expect(panel.getByText("发布已完成")).toBeVisible();
  await expect(panel.getByRole("link", { name: "打开发布页面" })).toHaveAttribute(
    "href",
    /\/browser-publication-report\/$/,
  );
});

test("shows the document scope of a pending publication before explicit confirmation", async ({
  page,
}) => {
  const workspace = await workspaceAsAdmin(page);
  const { note, commitId } = await deliver(page, workspace.id, "browser-mcp");
  const pending = await page.request.post("/api/v1/publications", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      workspaceId: workspace.id,
      targetId: "fixture-zola",
      operationId: randomUUID(),
      commitId,
      documentIds: [note.id],
      confirm: false,
    },
  });
  expect(pending.status(), await pending.text()).toBe(201);
  const proposal = (await pending.json()) as Publication;
  expect(proposal.status).toBe("pending");

  await page.goto(`/workspaces/${workspace.id}/manage`);
  const record = page
    .getByRole("list", { name: "发布记录" })
    .getByRole("listitem")
    .filter({ hasText: commitId });
  await expect(record).toContainText(note.path);
  await expect(record).toContainText("本地博客");
  await expect(record.getByRole("link", { name: "打开发布页面" })).toHaveCount(0);

  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/publications/${proposal.id}/confirm`),
  );
  await record.getByRole("button", { name: "确认发布" }).click();
  expect((await accepted).ok()).toBe(true);
  await expect(record.getByText("发布已完成")).toBeVisible();
  await expect(record.getByRole("link", { name: "打开发布页面" })).toHaveAttribute(
    "href",
    /\/browser-mcp-report\/$/,
  );
});
