import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { Workspace } from "../../src/api/client";
import { signIn } from "./productFixture";

const firstPassword = "fixture-test-password-initial";
const replacementPassword = "fixture-test-password-updated";

async function openCommand(page: Page, title: string) {
  await page.getByRole("button", { name: /^(搜索文档|命令)$/ }).click();
  await page.getByRole("searchbox").fill(title);
  await page.getByRole("option", { name: title, exact: true }).click();
}

for (const account of [
  { username: "reader", password: "reader-test-password", crossSpace: true },
  { username: "offline-reader", password: "offline-reader-test-password", crossSpace: false },
]) {
  test(`aligns search controls with ${account.crossSpace ? "multiple spaces" : "one space"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, account.username, account.password);
    const search = page.getByRole("button", { name: "搜索文档" });
    const settings = page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
    await settings.click();
    const preferences = page.getByRole("dialog", { name: "应用设置" });
    await expect(preferences).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    await search.click();
    const palette = page.getByRole("dialog", { name: "快速打开与全文搜索" });
    const input = palette.getByRole("searchbox");
    const close = palette.getByRole("button", { name: "关闭搜索" });
    const scope = palette.getByRole("button", { name: "跨空间" });
    await expect(input).toBeFocused();
    await expect(close).toBeVisible();
    await expect(scope).toHaveCount(account.crossSpace ? 1 : 0);
    const left = await input.boundingBox();
    const right = await close.boundingBox();
    if (!left || !right) throw new Error("Missing search row controls");
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(right.width).toBeGreaterThanOrEqual(44);
    expect(right.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(left.y + left.height / 2 - right.y - right.height / 2)).toBeLessThan(1);
    if (account.crossSpace) {
      const middle = await scope.boundingBox();
      if (!middle) throw new Error("Missing search scope");
      expect(Math.abs(middle.y + middle.height / 2 - right.y - right.height / 2)).toBeLessThan(1);
    }
    await input.press("Escape");
    await expect(search).toBeFocused();
    await search.press("Enter");
    await close.click();
    await expect(search).toBeFocused();
  });
}

test("topbar actions and settings fit a phone with double-size text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "reader", "reader-test-password");
  await page.getByRole("article").waitFor();
  await page.locator("html").evaluate((root) => (root.style.fontSize = "200%"));
  const settings = page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
  await expect(settings).toBeInViewport({ ratio: 1 });
  expect(await page.locator("html").evaluate((root) => root.scrollWidth)).toBe(390);
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  for (const name of ["外观", "阅读与布局", "快捷键"]) {
    const tab = dialog.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toBeInViewport({ ratio: 1 });
    const save = dialog.getByRole("button", { name: "保存设置" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    expect(await dialog.evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("switches to a long space name at 125% zoom on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const origin = new URL(page.url()).origin;
  const longName = `缩放时保持箭头和空间设置可用的超长空间名称-${randomUUID()}`;
  const workspace = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: longName },
  });
  expect(workspace.status()).toBe(201);
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const field = workspaces.find(({ name }) => name === "田野笔记");
  if (!field) throw new Error("Missing managed Workspace fixture");
  await page.goto(`/workspaces/${field.id}`);
  await page.evaluate(() => {
    document.documentElement.style.zoom = "125%";
  });
  await page.getByRole("button", { name: "展开目录" }).click();
  const currentSpace = page.getByRole("button", { name: /田野笔记/ });
  await currentSpace.click();
  await page.getByRole("menuitemradio", { name: longName, exact: true }).click();
  const selectedSpace = page.getByRole("button", { name: new RegExp(longName, "u") });
  const settings = page.getByRole("button", { name: "空间设置", exact: true });
  await expect(selectedSpace).toBeVisible();
  await expect(settings).toBeVisible();
  const arrowIcon = selectedSpace.locator("[aria-hidden=true]");
  await expect(arrowIcon).toHaveCSS("width", "16px");
  const arrow = await arrowIcon.boundingBox();
  const choice = await selectedSpace.boundingBox();
  const next = await settings.boundingBox();
  if (!arrow || !choice || !next) throw new Error("Missing space controls");
  expect(arrow.width).toBeCloseTo(20, 1);
  expect(arrow.x + arrow.width).toBeLessThan(choice.x + choice.width);
  expect(choice.x + choice.width).toBeLessThanOrEqual(next.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("opens a legacy release anchor and switches management tabs on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const workspace = workspaces.find(({ name }) => name === "田野笔记");
  if (!workspace) throw new Error("Missing managed Workspace fixture");

  await page.goto(`/workspaces/${workspace.id}/manage#release`);
  const tabs = page.getByRole("tablist", { name: "空间设置" });
  const release = tabs.getByRole("tab", { name: "备份与发布" });
  await expect(release).toHaveAttribute("aria-selected", "true");
  const tabTops = await tabs
    .getByRole("tab")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(Math.max(...tabTops) - Math.min(...tabTops)).toBeLessThan(1);
  await expect(release).toBeInViewport();
  await expect(page.getByRole("banner")).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("region", { name: "阅读地址" })).toBeVisible();
  await release.press("ArrowLeft");
  const imports = tabs.getByRole("tab", { name: "外部导入" });
  await expect(imports).toBeFocused();
  await expect(imports).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "阅读地址" })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.goto(`/workspaces/${workspace.id}/manage#directory`);
  await expect(tabs.getByRole("tab", { name: "常规" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("form", { name: "空间设置" })).toBeVisible();
  await expect(page.getByRole("region", { name: "移动或重命名" })).toHaveCount(0);
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
  await page.getByRole("tab", { name: "成员", exact: true }).click();
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
    await memberPage.goto(`/workspaces/${workspace.id}`);
    const memberSettings = memberPage.getByRole("button", { name: "空间设置", exact: true });
    await expect(memberSettings).toBeVisible();
    await memberSettings.click();
    await expect(memberPage.getByRole("tab", { name: "外部导入" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await memberPage.goto(`/workspaces/${workspace.id}/manage#release`);
    const memberTabs = memberPage.getByRole("tablist", { name: "空间设置" });
    await expect(memberTabs.getByRole("tab")).toHaveText(["外部导入"]);
    await expect(memberTabs.getByRole("tab", { name: "外部导入" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await member.getByRole("button", { name: "编辑权限" }).click();
    await expect(panel.getByRole("button", { name: "保存成员" })).toBeDisabled();
    await panel.getByRole("button", { name: /阅读.*权限|权限.*阅读/ }).click();
    await page.getByRole("option", { name: "编辑", exact: true }).click();
    const memberRequest = page.waitForRequest(
      (request) => request.method() === "PUT" && request.url().includes("/members/"),
    );
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/members/${username}`,
      async (route) => {
        await hold;
        await route.continue();
      },
      { times: 1 },
    );
    await panel.getByRole("button", { name: "保存成员" }).click();
    try {
      await memberRequest;
      await panel.getByLabel("成员用户名").fill("下一位成员");
    } finally {
      release();
    }
    await expect(member).toContainText("编辑");
    await expect(panel.getByLabel("成员用户名")).toHaveValue("下一位成员");
    const writable = (await (
      await memberPage.request.get("/api/v1/workspaces")
    ).json()) as Workspace[];
    expect(writable.find(({ id }) => id === workspace.id)?.canWrite).toBe(true);
    await memberPage.reload();
    await expect(memberTabs.getByRole("tab")).toHaveText(["外部导入", "备份与发布"]);
    await expect(memberPage.getByRole("region", { name: "阅读地址" })).toBeVisible();
    await member.getByRole("button", { name: "移除成员" }).click();
    const remove = page.getByRole("dialog", { name: "移除成员" });
    await expect(remove).toContainText("无法继续访问这个空间");
    await expect(remove.getByRole("button", { name: "取消" })).toBeVisible();
    await remove.getByRole("button", { name: "移除成员" }).click();
    await expect(member).toHaveCount(0);
    const removed = (await (
      await memberPage.request.get("/api/v1/workspaces")
    ).json()) as Workspace[];
    expect(removed.some(({ id }) => id === workspace.id)).toBe(false);
    await memberPage.goto("/");
    const preferences = memberPage
      .getByRole("banner")
      .getByRole("button", { name: "设置", exact: true });
    await preferences.click();
    await expect(memberPage.getByRole("dialog", { name: "应用设置" })).toBeVisible();
    await memberPage.keyboard.press("Escape");
    await expect(preferences).toBeFocused();
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

test("keyboard focus marks the import or publish control and a directly focused static panel", async ({
  page,
}) => {
  await signIn(page, "fixture-admin", "fixture-admin-test-password");
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const workspace = workspaces.find(({ name }) => name === "田野笔记");
  if (!workspace) throw new Error("Missing managed Workspace fixture");

  for (const { hash, label, role, name } of [
    { hash: "delivery", label: "外部导入", role: "button", name: "选择文件" },
    { hash: "release-site", label: "站点发布", role: "button", name: /发布目标/ },
    { hash: "release-backup", label: "Git 备份", role: "tabpanel", name: "Git 备份" },
  ] as const) {
    await page.goto(`/workspaces/${workspace.id}/manage#${hash}`);
    const control = page.getByRole(role, { name, exact: true });
    await expect(control).toBeVisible();
    await page.getByRole("tab", { name: label, exact: true }).press("Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-style", "solid");
    await expect(control).toHaveCSS("outline-width", "2px");
    const outlinedAncestors = await control.evaluate((node) => {
      const outlined: string[] = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).outlineStyle !== "none") {
          outlined.push(parent.getAttribute("data-slot") ?? parent.tagName);
        }
      }
      return outlined;
    });
    expect.soft(outlinedAncestors, label).toEqual([]);
  }
});
