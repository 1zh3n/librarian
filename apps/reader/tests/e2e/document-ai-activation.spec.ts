import { expect, test } from "@playwright/test";
import { openDocumentTool } from "./productFixture";
import { endpoint, openSettings, saved, selection, snapshot } from "./aiSettingsFixture";

test("legacy remains active until an online runner and an explicit replayable activation", async ({
  page,
}) => {
  let online = false;
  let managed = false;
  const activations: unknown[] = [];
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        dispatchMode: managed ? "managed" : "legacy",
        runnerOnline: online,
        connections: [{ ...saved, enabled: false }],
      },
    }),
  );
  await page.route(endpoint + "/managed-activation", (route) => {
    activations.push(route.request().postDataJSON());
    if (activations.length === 1) return route.abort("failed");
    managed = true;
    return route.fulfill({ status: 204 });
  });
  const probes: string[] = [];
  await page.route(endpoint + "/connections/*/probe", (route) => {
    probes.push(route.request().url());
    return route.fulfill({ status: 503 });
  });
  const dialog = await openSettings(page);
  const activate = dialog.getByRole("button", { name: "启用受管 AI", exact: true });
  await expect(activate).toBeDisabled();
  online = true;
  await dialog.getByRole("button", { name: "刷新服务状态" }).click();
  await expect(activate).toBeEnabled();
  const admin = dialog.getByRole("region", { name: "管理连接" });
  await admin.getByRole("button", { name: /思考等级/ }).click();
  await page.getByRole("option", { name: "heavy", exact: true }).click();
  await activate.click();
  const confirm = dialog.getByRole("button", { name: "确认启用受管 AI" });
  await expect(confirm).toBeVisible();
  expect(activations).toEqual([]);
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await confirm.click();
  await expect(activate).toHaveCount(0);
  expect(activations[0]).toEqual({
    activationId: expect.any(String),
    expectedSettingsVersion: 3,
    selection,
  });
  expect(activations).toEqual([activations[0], activations[0]]);
  expect(probes).toEqual([]);
});

test("explicit generation test sends the saved model once and polls its own receipt", async ({
  page,
}) => {
  const input: unknown[] = [];
  let reads = 0;
  await page.route(endpoint, (route) => route.fulfill({ json: snapshot }));
  await page.route(endpoint + "/connections/field/probe", (route) => {
    input.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: "probe-" + input.length, status: "queued" } });
  });
  await page.route(endpoint + "/probes/*", (route) => {
    reads++;
    if (reads === 1) return route.fulfill({ json: { id: "probe-1", status: "running" } });
    if (route.request().url().endsWith("/probe-1"))
      return route.fulfill({
        json: { id: "probe-1", status: "failed", errorCode: "authentication" },
      });
    return route.fulfill({ json: { id: "probe-2", status: "succeeded" } });
  });
  const dialog = await openSettings(page);
  const probe = dialog.getByRole("button", { name: "测试生成", exact: true });
  await dialog
    .getByRole("region", { name: "管理连接" })
    .getByRole("button", { name: /思考等级/ })
    .click();
  await page.getByRole("option", { name: "heavy", exact: true }).click();
  await probe.click();
  await expect(probe).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("认证");
  expect(input).toEqual([{ modelId: "field-model", thinking: selection.thinking }]);
  await probe.click();
  await expect(dialog.getByText("测试生成成功。")).toBeVisible();
  expect(input.length).toBe(2);
});

test("the open document chat observes a global pause when settings close", async ({ page }) => {
  let globalEnabled = true;
  await page.route(endpoint, (route) => route.fulfill({ json: { ...snapshot, globalEnabled } }));
  await page.route(endpoint + "/global-enabled", (route) => {
    globalEnabled = false;
    return route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const spaces = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    id: string;
    name: string;
  }[];
  await page.goto("/workspaces/" + spaces.find((space) => space.name === "田野笔记")!.id);
  await openDocumentTool(page, "AI");
  const chat = page.getByRole("region", { name: "文档 AI" });
  await chat.getByRole("textbox", { name: "提示词" }).fill("保留提问");
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  await dialog.getByRole("button", { name: "暂停全局 AI" }).click();
  await expect(dialog.getByRole("button", { name: "恢复全局 AI" })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(chat).toContainText("管理员已停用 AI");
  await expect(chat.getByRole("textbox", { name: "提示词" })).toHaveValue("保留提问");
});
