import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Workspace } from "../../src/api/client";

const firstPassword = "fixture-test-password-initial";
const replacementPassword = "fixture-test-password-updated";

async function signIn(page: Page, username: string, password: string) {
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

async function openCommand(page: Page, title: string) {
  await page.getByRole("button", { name: /^(搜索文档|命令)$/ }).click();
  await page.getByRole("searchbox").fill(title);
  await page.getByRole("option", { name: title, exact: true }).click();
}

test("jumps to the release tools from the management navigation on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const workspace = workspaces.find(({ name }) => name === "田野笔记");
  if (!workspace) throw new Error("Missing managed Workspace fixture");

  await page.goto(`/workspaces/${workspace.id}/manage`);
  const navigation = page.getByRole("navigation", { name: "工作区管理" });
  const release = navigation.getByRole("link", { name: "备份、发布与分享" });
  await release.focus();
  await page.keyboard.press("Enter");

  const section = page.getByRole("heading", { name: "备份、发布与分享" });
  await expect(section).toBeFocused();
  await expect(section).toBeInViewport();
  await expect(page.getByRole("banner")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("region", { name: "阅读地址" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test("manages a local account and applies Workspace membership through Reader", async ({
  page,
  browser,
}) => {
  const username = `reader-${randomUUID()}`;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  await openCommand(page, "账号管理");
  await expect(page.getByRole("heading", { name: "账号管理" })).toBeVisible();
  const create = page.getByRole("form", { name: "新建账号" });
  await create.getByLabel("用户名").fill(username);
  await create.getByLabel("初始密码").fill(firstPassword);
  await create.getByRole("button", { name: "创建账号" }).click();
  await expect(create.getByLabel("初始密码")).toHaveValue("");
  const account = page.getByRole("list", { name: "账号列表" }).getByRole("listitem").filter({
    hasText: username,
  });
  await expect(account).toContainText("普通账号");

  const origin = new URL(page.url()).origin;
  const response = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: "成员验收空间" },
  });
  expect(response.status()).toBe(201);
  const workspace = (await response.json()) as Workspace;
  await page.goto(`/workspaces/${workspace.id}/manage`);
  const panel = page.getByRole("region", { name: "空间成员" });
  await panel.getByLabel("成员用户名").fill(username);
  await panel.getByRole("button", { name: "保存成员" }).click();
  const member = panel.getByRole("listitem").filter({ hasText: username });
  await expect(member).toContainText("阅读");

  const memberContext = await browser.newContext({ baseURL: origin });
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, username, firstPassword);
    const readOnly = (await (
      await memberPage.request.get("/api/v1/workspaces")
    ).json()) as Workspace[];
    expect(readOnly.find(({ id }) => id === workspace.id)?.canWrite).toBe(false);
    await member.getByRole("button", { name: "编辑权限" }).click();
    await panel.getByRole("button", { name: /阅读.*权限|权限.*阅读/ }).click();
    await page.getByRole("option", { name: "编辑", exact: true }).click();
    await panel.getByRole("button", { name: "保存成员" }).click();
    await expect(member).toContainText("编辑");
    const writable = (await (
      await memberPage.request.get("/api/v1/workspaces")
    ).json()) as Workspace[];
    expect(writable.find(({ id }) => id === workspace.id)?.canWrite).toBe(true);
    await member.getByRole("button", { name: "移除成员" }).click();
    await expect(member).toHaveCount(0);
    const removed = (await (
      await memberPage.request.get("/api/v1/workspaces")
    ).json()) as Workspace[];
    expect(removed.some(({ id }) => id === workspace.id)).toBe(false);
    await memberPage.goto("/");
    await openCommand(memberPage, "修改密码");
    await expect(memberPage.getByRole("heading", { name: "修改密码" })).toBeVisible();
    await expect(memberPage.getByRole("form", { name: "新建账号" })).toHaveCount(0);

    await page.goto("/accounts");
    await account.getByRole("button", { name: "重置密码" }).click();
    const reset = account.getByRole("form", { name: "重置密码" });
    await reset.getByLabel("新密码").fill(replacementPassword);
    await reset.getByRole("button", { name: "保存密码" }).click();
    await expect(account).toContainText("已重置密码");
    expect((await memberPage.request.get("/api/v1/session")).status()).toBe(401);
    await signIn(memberPage, username, replacementPassword);
    await account.getByRole("button", { name: "撤销会话" }).click();
    await expect(account).toContainText("已撤销会话");
    expect((await memberPage.request.get("/api/v1/session")).status()).toBe(401);
    await signIn(memberPage, username, replacementPassword);
    await account.getByRole("button", { name: "停用账号" }).click();
    await expect(account).toContainText("已停用");
    expect((await memberPage.request.get("/api/v1/session")).status()).toBe(401);
  } finally {
    await memberContext.close();
  }
});

test("lets a member replace their password and starts a fresh browser session", async ({
  page,
  browser,
}) => {
  const username = `reader-${randomUUID()}`;
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const response = await page.request.post("/api/v1/accounts", {
    headers: { origin: new URL(page.url()).origin },
    data: { username, password: firstPassword },
  });
  expect(response.status()).toBe(201);

  const memberContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, username, firstPassword);
    await openCommand(memberPage, "修改密码");
    const password = memberPage.getByRole("form", { name: "修改密码" });
    await password.getByLabel("当前密码").fill(firstPassword);
    await password.getByLabel("新密码").fill(replacementPassword);
    await password.getByRole("button", { name: "保存密码" }).click();
    await expect(memberPage.getByRole("heading", { name: "登录 Librarian" })).toBeVisible();
    expect((await memberPage.request.get("/api/v1/session")).status()).toBe(401);
    await signIn(memberPage, username, replacementPassword);
    const session = await memberPage.request.get("/api/v1/session");
    expect(session.status()).toBe(200);
    expect(await session.json()).toMatchObject({ username, isAdmin: false });
  } finally {
    await memberContext.close();
  }
});
