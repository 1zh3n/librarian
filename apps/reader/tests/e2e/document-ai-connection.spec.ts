import { expect, test } from "@playwright/test";
import {
  endpoint,
  models,
  official,
  openSettings,
  saved,
  selection,
  snapshot,
} from "./aiSettingsFixture";

test("discovery binds create, rotated credentials and the saved connection version", async ({
  page,
}) => {
  let step = 0;
  await page.route(endpoint, (route) =>
    route.fulfill({ json: { ...snapshot, connections: step ? [saved] : [] } }),
  );
  await page.route(endpoint + "/discover", (route) =>
    route.fulfill({ json: { models, discoveryId: "ticket-" + step, fetchedAt: saved.fetchedAt } }),
  );
  const writes: unknown[] = [];
  await page.route(endpoint + "/connections**", async (route) => {
    writes.push(route.request().postDataJSON());
    step++;
    await route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page);
  const label = dialog.getByLabel("连接名称");
  const submit = dialog.getByRole("button", { name: "保存连接" });
  await label.fill("田野模型");
  await expect(submit).toBeDisabled();
  await dialog.getByLabel("API Key", { exact: true }).fill("first-secret");
  const effort = dialog
    .getByRole("region", { name: "管理连接" })
    .getByRole("button", { name: /思考等级/ });
  await effort.click();
  await page.getByRole("option", { name: "heavy", exact: true }).click();
  await submit.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    label: "田野模型",
    provider: "deepseek",
    baseUrl: official,
    keyChange: { kind: "replace", apiKey: "first-secret" },
    discoveryId: "ticket-0",
  });
  await expect(dialog.getByText("已配置密钥", { exact: true })).toBeVisible();
  await expect(effort).toContainText("heavy");
  const key = dialog.getByLabel("API Key", { exact: true });
  await expect(key).toBeEmpty();
  const url = dialog.getByLabel("API 基础地址");
  await url.fill("https://other.example.test");
  await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "刷新模型" })).toBeDisabled();
  await key.fill("second-secret");
  await submit.click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toMatchObject({
    expectedVersion: 7,
    baseUrl: "https://other.example.test",
    keyChange: { kind: "replace", apiKey: "second-secret" },
    discoveryId: "ticket-1",
  });
});

test("a stale saved catalog refreshes with its connection ID and survives a transient error", async ({
  page,
}) => {
  const requests: unknown[] = [];
  const writes: unknown[] = [];
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: { ...snapshot, connections: [{ ...saved, fetchedAt: saved.fetchedAt - 910 }] },
    }),
  );
  await page.route(endpoint + "/discover", (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1)
      return route.fulfill({ status: 504, json: { code: "provider_timeout" } });
    return route.fulfill({
      json: { models: [{ id: "new-model" }], discoveryId: "fresh", fetchedAt: saved.fetchedAt },
    });
  });
  await page.route(endpoint + "/connections/field", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page);
  await expect(dialog.getByRole("alert")).toContainText("超时");
  await expect(dialog.getByRole("button", { name: /field-model 模型/ })).toBeVisible();
  await dialog.getByRole("button", { name: "刷新模型" }).click();
  await expect(dialog.getByRole("button", { name: /new-model 模型/ })).toBeVisible();
  expect(requests).toEqual([{ connectionId: "field" }, { connectionId: "field" }]);
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "保存连接" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    expectedVersion: 7,
    discoveryId: "fresh",
    keyChange: { kind: "keep" },
  });
});

test("a member selects an enabled model and can return to the global default", async ({ page }) => {
  let preference: typeof selection | null = null;
  const writes: unknown[] = [];
  await page.route(endpoint, (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        dispatchMode: "managed",
        preference,
        defaultSelection: selection,
        effectiveSelection: selection,
      },
    }),
  );
  await page.route(endpoint + "/preference", (route) => {
    const data = route.request().postDataJSON() as { selection: typeof selection | null };
    preference = data.selection;
    writes.push(data);
    return route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page, false);
  await expect(dialog.getByLabel("API Key")).toHaveCount(0);
  const mine = dialog.getByRole("region", { name: "我的模型" });
  await mine.getByRole("button", { name: /模型连接/ }).click();
  await page.getByRole("option", { name: "田野模型", exact: true }).click();
  await mine.getByRole("button", { name: /思考等级/ }).click();
  await page.getByRole("option", { name: "heavy", exact: true }).click();
  await mine.getByRole("button", { name: "保存偏好" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ selection });
  await mine.getByRole("button", { name: /模型连接/ }).click();
  await page.getByRole("option", { name: "跟随全局默认" }).click();
  await mine.getByRole("button", { name: "保存偏好" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1]).toEqual({ selection: null });
});

test("administrator changes global state and defaults independently of credential edits", async ({
  page,
}) => {
  const writes: unknown[] = [];
  let globalEnabled = true;
  await page.route(endpoint, (route) =>
    route.fulfill({ json: { ...snapshot, dispatchMode: "managed", globalEnabled } }),
  );
  for (const path of ["global-enabled", "default"])
    await page.route(endpoint + "/" + path, (route) => {
      const body = route.request().postDataJSON() as { enabled?: boolean };
      writes.push(body);
      if (body.enabled !== undefined) globalEnabled = body.enabled;
      return route.fulfill({ status: 204 });
    });
  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "暂停全局 AI" }).click();
  await expect(dialog.getByRole("button", { name: "恢复全局 AI" })).toBeVisible();
  const admin = dialog.getByRole("region", { name: "管理连接" });
  await admin.getByRole("button", { name: /思考等级/ }).click();
  await page.getByRole("option", { name: "heavy", exact: true }).click();
  await admin.getByRole("button", { name: "设为全局默认" }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes).toEqual([{ enabled: false }, { selection }]);
});

test("version conflicts preserve the draft and clear, disable, and removal use explicit commands", async ({
  page,
}) => {
  let connection: typeof saved | undefined = { ...saved };
  const writes: unknown[] = [];
  await page.route(endpoint, (route) =>
    route.fulfill({ json: { ...snapshot, connections: connection ? [connection] : [] } }),
  );
  await page.route(endpoint + "/connections/field**", (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      writes.push([request.method(), new URL(request.url()).searchParams.get("expectedVersion")]);
      connection = undefined;
    } else {
      const body = request.postDataJSON() as {
        label?: string;
        enabled?: boolean;
        keyChange?: { kind: string };
      };
      writes.push(body);
      if (body.label === "待处理")
        return route.fulfill({ status: 409, json: { code: "connection_version_conflict" } });
      connection = {
        ...connection!,
        version: connection!.version + 1,
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.keyChange?.kind === "clear" && { hasApiKey: false, credentialAvailable: false }),
      };
    }
    return route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page);
  const label = dialog.getByLabel("连接名称");
  await label.fill("待处理");
  await dialog.getByRole("button", { name: "保存连接" }).click();
  await expect(dialog.getByRole("alert")).toContainText("版本");
  await expect(label).toHaveValue("待处理");
  await dialog.getByRole("button", { name: "重新读取设置" }).click();
  await expect(label).toHaveValue("田野模型");
  await dialog.getByRole("button", { name: "停用连接", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "启用连接", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "清除密钥", exact: true }).click();
  await dialog.getByRole("button", { name: "确认清除" }).click();
  await expect(dialog.getByRole("button", { name: "清除密钥", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "移除连接", exact: true }).click();
  await dialog.getByRole("button", { name: "确认移除" }).click();
  await expect.poll(() => writes.length).toBe(4);
  expect(writes.slice(1)).toEqual([
    { expectedVersion: 7, enabled: false },
    { expectedVersion: 8, keyChange: { kind: "clear" } },
    ["DELETE", "9"],
  ]);
});

test("a saved catalog already committed by discovery supplies the next connection version", async ({
  page,
}) => {
  const initial = { ...saved, fetchedAt: saved.fetchedAt - 1000 };
  const current = { ...saved, version: 8, models: [{ id: "updated" }] };
  let refreshed = false;
  await page.route(endpoint, (route) =>
    route.fulfill({ json: { ...snapshot, connections: [refreshed ? current : initial] } }),
  );
  await page.route(endpoint + "/discover", (route) => {
    refreshed = true;
    return route.fulfill({
      json: { discoveryId: "saved-catalog", fetchedAt: current.fetchedAt, models: current.models },
    });
  });
  const writes: unknown[] = [];
  await page.route(endpoint + "/connections/field", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  const dialog = await openSettings(page);
  await expect(dialog.getByRole("button", { name: "updated 模型" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "保存连接" })).toBeDisabled();
  await dialog.getByRole("button", { name: "停用连接", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes).toEqual([{ expectedVersion: 8, enabled: false }]);
});

test("changing the signed-in account hides the previous settings while the new snapshot loads", async ({
  page,
}) => {
  let member = false;
  let release = () => {};
  const memberSettings = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/api/v1/session", (route) =>
    member
      ? route.fulfill({ json: { username: "member-after-change", isAdmin: false } })
      : route.continue(),
  );
  await page.route(endpoint, async (route) => {
    if (member) {
      await memberSettings;
      await route.fulfill({
        json: { ...snapshot, connections: [], preference: null, effectiveSelection: null },
      });
    } else {
      await route.fulfill({
        json: {
          ...snapshot,
          connections: [{ ...saved, label: "管理员的原连接" }],
          effectiveSelection: selection,
        },
      });
    }
  });
  const dialog = await openSettings(page);
  const mine = dialog.getByRole("region", { name: "我的模型" });
  await expect(mine).toContainText("管理员的原连接");
  await page.clock.install();
  try {
    member = true;
    await page.clock.fastForward(25000);
    const refreshed = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/session"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await refreshed;
    await expect(dialog.getByLabel("API Key")).toHaveCount(0);
    await expect(dialog).not.toContainText("管理员的原连接");
  } finally {
    release();
  }
  await expect(mine).toContainText("尚无已启用");
});
