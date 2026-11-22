import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import type { AiDiscoveryInput, DiscoveredModel, Workspace } from "../../src/api/client";
import { expandAdminSections } from "./aiSettingsFixture";
import { createNote, openDocumentTool, openFieldWorkspace } from "./productFixture";

const endpoint = "**/api/v1/ai/settings/discover";
const official = "https://api.deepseek.com";
const catalog: DiscoveredModel[] = [
  {
    id: "model-a",
    name: "田野推理",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    effort: { supportedLevels: ["quick", "careful"], defaultLevel: "quick" },
  },
  { id: "model-b" },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/ai/settings", (route) =>
    route.fulfill({
      json: {
        settingsVersion: 1,
        globalEnabled: true,
        dispatchMode: "legacy",
        connections: [],
        defaultSelection: null,
        preference: null,
        effectiveSelection: null,
        fallbackReason: null,
        runnerOnline: false,
      },
    }),
  );
});

async function admin(page: Page) {
  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("fixture-admin");
  await page.getByLabel("密码", { exact: true }).fill("fixture-admin-test-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}

const trigger = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "设置", exact: true });
const settings = (page: Page) => page.getByRole("dialog", { name: "应用设置" });

async function openAi(page: Page) {
  await trigger(page).click();
  const dialog = settings(page);
  const tab = dialog.getByRole("tab", { name: "AI", exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  await expandAdminSections(dialog);
  return dialog;
}

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function respond(route: Route, models: DiscoveredModel[]) {
  return route.fulfill({
    json: { discoveryId: "fixture-ticket", fetchedAt: 1_795_219_200, models },
  });
}

test("top_bar_discovers_models_before_first_chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await admin(page);
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await expect(page.getByText("没有可访问的空间")).toBeVisible();
  const calls: AiDiscoveryInput[] = [];
  await page.route(endpoint, (route) => {
    calls.push(route.request().postDataJSON() as AiDiscoveryInput);
    return respond(route, calls.length === 1 ? catalog : [{ id: "replacement" }]);
  });
  const dialog = await openAi(page);
  const refresh = dialog.getByRole("button", { name: "刷新模型" });
  const key = dialog.getByLabel("API Key", { exact: true });
  await expect(dialog.getByLabel("API 基础地址")).toHaveValue(official);
  await expect(refresh).toBeDisabled();
  await expect(key).toHaveAttribute("type", "password");
  await key.pressSequentially("fixture-key", { delay: 10 });
  const model = dialog.getByRole("button", { name: / 模型$/ });
  await expect(model).toContainText("田野推理");
  expect(calls).toEqual([{ provider: "deepseek", baseUrl: official, apiKey: "fixture-key" }]);
  await expect(key).toBeFocused();
  await test
    .info()
    .attach("desktop-catalog", { body: await page.screenshot(), contentType: "image/png" });
  await expect(dialog.getByText("model-a", { exact: true })).toBeVisible();
  const capability = dialog.getByRole("button", { name: /模型能力/ });
  await expect(capability).toContainText("输入 文本、图片");
  await expect(capability).toContainText("输出 文本");
  const effort = dialog.getByRole("button", { name: /思考等级/ });
  await expect(effort).toContainText("供应商默认");
  await expect(effort).toContainText("quick");
  await effort.click();
  await expect(page.getByRole("option")).toHaveText([/供应商默认/, "关闭思考", "quick", "careful"]);
  await page.getByRole("option", { name: "careful" }).click();
  await expect(effort).toContainText("careful");
  await model.click();
  await page.getByRole("option", { name: "model-b" }).click();
  await expect(effort).toContainText("供应商默认");
  await expect(dialog.getByText(/未提供思考等级/)).toBeVisible();
  await refresh.click();
  await expect(model).toContainText("replacement");
  await model.click();
  await expect(page.getByRole("option")).toHaveText(["replacement"]);
  await page.keyboard.press("Escape");
  await expect(model).toBeFocused();
  await model.press("Escape");
  await expect(trigger(page)).toBeFocused();
  await openAi(page);
  await expect(key).toBeEmpty();
});

for (const change of ["baseUrl", "apiKey"] as const) {
  test(`late discovery cannot replace the catalog after changing ${change}`, async ({ page }) => {
    await admin(page);
    const old = gate();
    const started = gate();
    const finished = gate();
    await page.route(endpoint, async (route) => {
      const draft = route.request().postDataJSON() as AiDiscoveryInput;
      if (draft.apiKey === "first-key" && draft.baseUrl === official) {
        started.resolve();
        await old.promise;
        await respond(route, [{ id: "stale-model" }]);
        finished.resolve();
      } else {
        await respond(route, [{ id: "current-model" }]);
      }
    });
    const dialog = await openAi(page);
    const key = dialog.getByLabel("API Key", { exact: true });
    try {
      await key.fill("first-key");
      await started.promise;
      if (change === "apiKey") await key.fill("second-key");
      else await dialog.getByLabel("API 基础地址").fill("https://catalog.example.test/v1");
      const model = dialog.getByRole("button", { name: /current-model/ });
      await expect(model).toBeVisible();
      old.resolve();
      await finished.promise;
      await model.click();
      await expect(page.getByRole("option")).toHaveText(["current-model"]);
    } finally {
      old.resolve();
    }
  });
}

test("empty catalog and failed discovery can be retried without retyping the key", async ({
  page,
}) => {
  await admin(page);
  let attempts = 0;
  await page.route(endpoint, (route) => {
    attempts++;
    if (attempts === 1) return respond(route, []);
    if (attempts === 2)
      return route.fulfill({
        status: 502,
        json: { code: "provider_auth_failed", message: "fixture-secret" },
      });
    if (attempts === 3)
      return route.fulfill({
        status: 429,
        json: { code: "rate_limited", message: "fixture-secret" },
      });
    return respond(route, catalog);
  });
  const dialog = await openAi(page);
  const key = dialog.getByLabel("API Key", { exact: true });
  await key.fill("fixture-secret");
  await expect(dialog.getByRole("alert")).toContainText(/模型/);
  const refresh = dialog.getByRole("button", { name: "刷新模型" });
  await refresh.click();
  await expect(dialog.getByRole("alert")).toContainText(/认证|密钥无效/);
  await refresh.click();
  await expect(dialog.getByRole("alert")).toContainText(/频繁|限流/);
  await expect(dialog).not.toContainText("fixture-secret");
  await refresh.click();
  await expect(dialog.getByRole("button", { name: /田野推理/ })).toBeVisible();
  await key.fill("");
  await expect(refresh).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /田野推理/ })).toHaveCount(0);
});

test("members open settings in a document and Workspace AI without connection controls", async ({
  page,
}) => {
  const workspace = await openFieldWorkspace(page);
  await page.goto(`/workspaces/${workspace.id}`);
  await openDocumentTool(page, "AI");
  const panel = page.getByRole("region", { name: "文档 AI" });
  await panel.getByRole("textbox").fill("保留这份提问");
  const main = page.getByRole("main");
  await main.evaluate((node) => {
    node.scrollTop = 320;
  });
  const before = await main.evaluate((node) => node.scrollTop);
  const dialog = await openAi(page);
  await expect(dialog.getByText(/管理员/)).toBeVisible();
  await expect(dialog.getByLabel("API Key")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger(page)).toBeFocused();
  await expect(panel.getByRole("textbox")).toHaveValue("保留这份提问");
  expect(await main.evaluate((node) => node.scrollTop)).toEqual(before);
  await page.getByRole("button", { name: "搜索文档" }).click();
  await page.getByRole("option", { name: "工作区 AI", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作区 AI" })).toBeVisible();
  await openAi(page);
  await dialog.getByRole("button", { name: "关闭应用设置", exact: true }).click();
  await expect(trigger(page)).toBeFocused();
});

test("settings preserve the selected reading passage and editor selection with undo", async ({
  page,
}) => {
  const paragraph = "湿地观测保留原始位置。";
  await createNote(page, "AiSettingsSelection.md", "岸边记录。".repeat(420) + "\n\n" + paragraph);
  const reader = page.getByRole("article");
  await reader.getByText(paragraph, { exact: true }).evaluate((node) => {
    node.scrollIntoView({ block: "center" });
    const text = node.firstChild!;
    window.getSelection()!.setBaseAndExtent(text, 4, text, 0);
  });
  const main = page.getByRole("main");
  const scroll = await main.evaluate((node) => node.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await openAi(page);
  await page.keyboard.press("Escape");
  await expect(trigger(page)).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("湿地观测");
  expect(await main.evaluate((node) => node.scrollTop)).toBe(scroll);
  await reader.press("Alt+e");
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+End");
  await page.keyboard.insertText("草稿");
  await editor.press("Shift+ArrowLeft");
  await openAi(page);
  await page.keyboard.press("Escape");
  await expect(trigger(page)).toBeFocused();
  await reader.press("Alt+e");
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("稿");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("草稿");
});

test("directory discovery waits for composition and ignores incomplete fields", async ({
  page,
}) => {
  await admin(page);
  const requests: AiDiscoveryInput[] = [];
  await page.route(endpoint, (route) => {
    requests.push(route.request().postDataJSON() as AiDiscoveryInput);
    return respond(route, catalog);
  });
  const dialog = await openAi(page);
  const url = dialog.getByLabel("API 基础地址");
  const key = dialog.getByLabel("API Key", { exact: true });
  await url.fill("https://");
  await key.fill("fixture-draft");
  await expect(dialog.getByRole("button", { name: "刷新模型" })).toBeDisabled();
  await key.dispatchEvent("compositionstart");
  await url.fill(official);
  await key.fill("fixture-composing");
  await expect(dialog.getByRole("button", { name: "刷新模型" })).toBeDisabled();
  await key.dispatchEvent("compositionend");
  await expect(dialog.getByRole("button", { name: /田野推理/ })).toBeVisible();
  expect(requests.map((draft) => draft.apiKey)).toEqual(["fixture-composing"]);
});

test.describe("AI connection form on touch screens", () => {
  test.use({ hasTouch: true });
  for (const [width, textSize] of [
    [390, 100],
    [360, 100],
    [390, 200],
    [320, 100],
  ] as const) {
    test(`fields, model choices and dismissal stay reachable at ${width}px and ${textSize}% text`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await admin(page);
      const spaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
      const field = spaces.find((space) => space.name === "田野笔记")!;
      await page.goto(`/workspaces/${field.id}/ai`);
      await page.getByRole("heading", { name: "工作区 AI" }).waitFor();
      await page.locator("html").evaluate((root, size) => {
        root.style.fontSize = size + "%";
      }, textSize);
      await expect(trigger(page)).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("button", { name: "搜索文档" })).toBeInViewport({ ratio: 1 });
      await page.route(endpoint, (route) => respond(route, catalog));
      await trigger(page).tap();
      const dialog = settings(page);
      await dialog.getByRole("tab", { name: "AI", exact: true }).tap();
      await expandAdminSections(dialog);
      const key = dialog.getByLabel("API Key", { exact: true });
      await key.fill("fixture-touch");
      await expect(dialog.getByRole("button", { name: /田野推理/ })).toBeVisible();
      await test
        .info()
        .attach("phone-catalog", { body: await page.screenshot(), contentType: "image/png" });
      // Reduced viewport approximates the space left by an on-screen keyboard.
      await page.setViewportSize({ width, height: 390 });
      await key.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(key).toBeInViewport({ ratio: 1 });
      const refresh = dialog.getByRole("button", { name: "刷新模型" });
      await refresh.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(refresh).toBeInViewport({ ratio: 1 });
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBe(width);
      await dialog.getByRole("button", { name: "关闭应用设置", exact: true }).tap();
      await expect(trigger(page)).toBeFocused();
    });
  }
});

test("Tab from a completed key keeps a focus target for Escape during automatic discovery", async ({
  page,
}) => {
  await admin(page);
  const started = gate();
  const reply = gate();
  await page.route(endpoint, async (route) => {
    started.resolve();
    await reply.promise;
    await respond(route, catalog);
  });
  const dialog = await openAi(page);
  const key = dialog.getByLabel("API Key", { exact: true });
  const refresh = dialog.getByRole("button", { name: "刷新模型" });
  try {
    await key.fill("fixture-focus");
    await key.press("Tab");
    await expect(refresh).toBeFocused();
    await started.promise;
    await expect(dialog.getByText("正在获取模型目录…")).toBeVisible();
    test.info().annotations.push({
      type: "pending-focus",
      description: await page.evaluate(() => document.activeElement?.tagName ?? "none"),
    });
  } finally {
    reply.resolve();
  }
  await expect(dialog.getByRole("button", { name: /田野推理/ })).toBeVisible();
  const active = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    role: document.activeElement?.getAttribute("role"),
  }));
  test.info().annotations.push({ type: "catalog-focus", description: JSON.stringify(active) });
  await expect(refresh, JSON.stringify(active)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog, JSON.stringify(active)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("long provider IDs wrap inside the narrow settings form and model menu", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await admin(page);
  const id = "reasoning_model_".repeat(12);
  await page.route(endpoint, (route) => respond(route, [{ id }]));
  const dialog = await openAi(page);
  await dialog.getByLabel("API Key", { exact: true }).fill("fixture-layout");
  const model = dialog.getByRole("button", { name: / 模型$/ });
  await expect(model).toBeVisible();
  expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
  await model.click();
  const option = page.getByRole("option", { name: id });
  await expect(option).toBeInViewport({ ratio: 1 });
  await option.press("Enter");
  await expect(model).toBeFocused();
  await expect(model).toContainText(id);
  await expect(model.locator("..")).toHaveCSS("outline-style", "none");
  await page.setViewportSize({ width: 1440, height: 900 });
  const effort = dialog.getByRole("button", { name: /思考等级/ });
  const top = async (element: typeof model) =>
    element.evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs((await top(model)) - (await top(effort)))).toBeLessThan(2);
});
