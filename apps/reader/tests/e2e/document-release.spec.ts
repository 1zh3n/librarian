import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type {
  BackupJob,
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

test("shows the deployment path when no backup target is configured", async ({ page }) => {
  const workspace = await workspaceAsAdmin(page);
  await page.goto(`/workspaces/${workspace.id}/manage`);
  await page.getByRole("tab", { name: "备份与发布" }).click();
  await page.getByRole("tab", { name: "Git 备份", exact: true }).click();
  const panel = page.getByRole("region", { name: "GitHub 备份" });
  await expect(panel).toContainText("尚未配置备份目标");
  await expect(panel).toContainText(".librarian/backup-targets.json");
  await expect(panel.getByRole("button", { name: "立即备份" })).toHaveCount(0);
});

test("retries unsaved backup settings and reloads the confirmed Git receipt", async ({ page }) => {
  const workspace = await workspaceAsAdmin(page, "浏览器本地备份");
  const { commitId } = await deliver(page, workspace.id, "browser-backup");
  await page.goto(`/workspaces/${workspace.id}/manage`);
  await page.getByRole("tab", { name: "备份与发布" }).click();
  await page.getByRole("tab", { name: "Git 备份", exact: true }).click();

  const panel = page.getByRole("region", { name: "Git 备份" });
  await expect(panel).toContainText("备份目标已配置");
  await expect(panel.getByRole("button", { name: "立即备份" })).toBeDisabled();
  await panel.getByRole("button", { name: /备份目标/ }).click();
  await page.getByRole("option", { name: "本地备份" }).click();
  await panel.getByRole("button", { name: /备份粒度/ }).click();
  await page.getByRole("option", { name: "逐操作" }).click();
  const settingsPath = `**/api/v1/workspaces/${workspace.id}/backup`;
  const save = panel.getByRole("button", { name: "保存备份设置" });
  await page.route(settingsPath, (route) =>
    route.request().method() === "PUT" ? route.abort("connectionreset") : route.continue(),
  );
  await save.press("Enter");
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByRole("button", { name: /备份目标/ })).toContainText("本地备份");
  await expect(panel.getByRole("button", { name: /备份粒度/ })).toContainText("逐操作");
  await expect(panel.getByRole("button", { name: "立即备份" })).toBeDisabled();
  await expect(panel.getByRole("alert")).toContainText("重试保存");

  await page.unroute(settingsPath);
  const response = page.waitForResponse(
    (entry) => entry.request().method() === "PUT" && entry.url().endsWith("/backup"),
  );
  await save.press("Enter");
  const confirmed = await response;
  expect(confirmed.ok()).toBe(true);
  expect(await confirmed.json()).toMatchObject({
    targetId: "fixture-backup",
    mode: "each-operation",
  });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByText("备份设置已保存")).toBeVisible();
  await expect(panel).toContainText("已选择目标，尚未备份");
  await expect(panel).toContainText("workspace-backup");
  const completed = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/backup/jobs"),
  );
  await panel.getByRole("button", { name: "立即备份" }).click();
  const receipt = (await (await completed).json()) as BackupJob;
  await expect(panel.getByText("备份已完成")).toBeVisible();
  await expect(panel).toContainText(commitId);
  await page.reload();
  await expect(panel.getByText("备份已完成")).toBeVisible();
  await expect(panel.getByRole("button", { name: /逐操作.*备份粒度/ })).toBeVisible();

  // Hold the confirmed settings response while the user edits the next draft.
  const mode = panel.getByRole("button", { name: /备份粒度/ });
  await mode.click();
  await page.getByRole("option", { name: "按批聚合" }).click();
  let releaseResponse!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(settingsPath, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const result = await route.fetch();
    await hold;
    await route.fulfill({ response: result });
  });
  try {
    await save.press("Enter");
    await expect(panel.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    await mode.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(mode).toContainText("逐操作");
  } finally {
    releaseResponse();
  }
  await expect(save).toBeEnabled();
  await expect(mode).toContainText("逐操作");
  await expect(panel.getByRole("button", { name: "立即备份" })).toBeDisabled();
  await expect(panel.getByText("备份设置已保存")).toHaveCount(0);
  const stored = await page.request.get(`/api/v1/workspaces/${workspace.id}/backup`);
  expect(await stored.json()).toMatchObject({ targetId: "fixture-backup", mode: "grouped" });
  await page.unroute(settingsPath);
  await save.press("Enter");
  await expect(panel.getByText("备份设置已保存")).toBeVisible();
  await page.reload();
  await expect(mode).toContainText("逐操作");

  // Supply persisted failed and interrupted states while keeping retries on the real product API.
  for (const { status, label } of [
    { status: "failed", label: "重试备份" },
    { status: "queued", label: "继续备份" },
  ] as const) {
    const prior = { ...receipt, status, commitId: null };
    const configPath = `**/api/v1/workspaces/${workspace.id}/backup`;
    const receiptPath = `${configPath}/jobs/${receipt.id}`;
    const startPath = `${configPath}/jobs`;
    let pending = true;
    await page.route(configPath, async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: pending ? { ...config, lastJob: prior } : config });
    });
    await page.route(receiptPath, (route) => route.fulfill({ json: prior }));
    await page.route(startPath, async (route) => {
      const response = await route.fetch();
      pending = false;
      await route.fulfill({ response });
    });
    await page.reload();

    const [response] = await Promise.all([
      page.waitForResponse(
        (entry) => entry.request().method() === "POST" && entry.url().endsWith("/backup/jobs"),
      ),
      panel.getByRole("button", { name: label }).click(),
    ]);
    expect(response.request().postDataJSON()).toEqual({ operationId: receipt.id });
    expect(await response.json()).toEqual(receipt);
    await expect(panel.getByText("备份已完成")).toBeVisible();
    await page.unroute(configPath);
    await page.unroute(receiptPath);
    await page.unroute(startPath);
  }
  await page.route(`**/api/v1/workspaces/${workspace.id}/backup`, async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, targetId: null, targetNeedsSelection: true, lastJob: null },
    });
  });
  await page.reload();
  await expect(panel.getByRole("alert")).toContainText("请重新选择并保存");
  await expect(panel.getByRole("button", { name: "立即备份" })).toBeDisabled();
});

test("publishes the explicitly selected Git version and documents to the configured target", async ({
  page,
}) => {
  const workspace = await workspaceAsAdmin(page);
  const { note, commitId } = await deliver(page, workspace.id, "browser-publication");
  await page.goto(`/workspaces/${workspace.id}/manage`);
  await page.getByRole("tab", { name: "备份与发布" }).click();
  await page.getByRole("tab", { name: "站点发布", exact: true }).click();
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
  await page.getByRole("tab", { name: "备份与发布" }).click();
  await page.getByRole("tab", { name: "站点发布", exact: true }).click();
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

async function seedCollection(page: Page, count: number) {
  await workspaceAsAdmin(page);
  const origin = new URL(page.url()).origin;
  const created = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: `水系走查-${randomUUID()}`, origin: "native" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = (await created.json()) as Workspace;
  const base = `/api/v1/workspaces/${workspace.id}`;
  const notes: DocumentSummary[] = [];
  for (let i = 1; i <= count; i++) {
    const title = `第${String(i).padStart(2, "0")}章 · 沿江村落的水系与生活记录`;
    const response = await page.request.post(`${base}/documents`, {
      headers: { origin },
      data: {
        path: `沿江/${title}.md`,
        markdown: `# ${title}\n\n渡口走访记录。\n`,
        baseRevision: null,
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    notes.push((await response.json()).document);
  }
  return { workspace, notes, base, origin };
}

test("opens sharing directly and keeps the scope when filtering a collection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { workspace, notes } = await seedCollection(page, 7);
  await page.goto(`/workspaces/${workspace.id}/manage#release`);
  const form = page.getByRole("form", { name: "创建阅读地址" });
  await expect(page.getByRole("region", { name: "Zola 发布" })).toBeHidden();
  await expect(form.getByRole("group", { name: "文档范围" })).toBeInViewport();
  await expect(form.getByLabel("地址到期时间（可选）")).toBeHidden();
  const filter = form.getByRole("textbox", { name: "筛选文档" });
  await filter.fill("第01章");
  await form.getByText(notes[0]!.path, { exact: true }).click();
  await filter.fill("没有这一篇");
  await expect(form.getByText("没有匹配的文档")).toBeVisible();
  await filter.fill("第07章");
  await form.getByText(notes[6]!.path, { exact: true }).click();
  await expect(form.getByText("已选 2 篇")).toBeVisible();
  const request = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/snapshots"),
  );
  await form.getByRole("button", { name: "创建阅读地址" }).click();
  expect((await request).postDataJSON().documentIds).toEqual([notes[0]!.id, notes[6]!.id]);
  await expect(page.getByRole("link", { name: "打开阅读地址" })).toBeVisible();
  await page.getByRole("tab", { name: "站点发布" }).click();
  await expect(page.getByRole("region", { name: "Zola 发布" })).toBeVisible();
  await page.getByRole("tab", { name: "阅读地址" }).click();
  await expect(form.getByText("已选 2 篇")).toBeVisible();
});

test("starts a long shared collection in the article and focuses the chosen chapter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { notes, base, origin } = await seedCollection(page, 16);
  const response = await page.request.post(`${base}/snapshots`, {
    headers: { origin },
    data: { kind: "current", audience: "members", documentIds: notes.map((n) => n.id) },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto((await response.json()).url);
  const article = page.getByRole("article");
  await expect(article.getByText("渡口走访记录。")).toBeInViewport();
  const directory = page.getByRole("button", { name: /文档目录.*16/ });
  await directory.press("Enter");
  const nav = page.getByRole("navigation", { name: "阅读地址中的文档" });
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await nav
    .getByRole("link", { name: notes[15]!.path.split("/").at(-1)! })
    .press("Enter");
  const heading = article.getByRole("heading", { level: 1, name: notes[15]!.title });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(directory).toHaveAttribute("aria-expanded", "false");
});
