import { expect, test } from "@playwright/test";
import { openFieldWorkspace } from "./productFixture";

for (const { date, error } of [
  { date: "", error: "请填写到期时间。" },
  { date: "2000-01-01T12:00", error: "到期时间必须晚于现在。" },
]) {
  test(`reopens the folded form to correct ${date ? "a past" : "a missing"} expiry`, async ({
    page,
  }) => {
    await openFieldWorkspace(page);
    await page.goto("/workspaces/new");
    const form = page.getByRole("form", { name: "新建空间" });
    const name = form.getByLabel("空间名称");
    await name.fill("临时资料");
    await form.getByRole("button", { name: "高级选项" }).click();
    await form.getByRole("button", { name: /空间用途/ }).click();
    await page.getByRole("option", { name: "外部文档接收" }).click();
    await form.getByRole("button", { name: /保留方式/ }).click();
    await page.getByRole("option", { name: "临时保存" }).click();
    const expires = form.getByLabel("到期时间");
    await expires.fill(date);
    if (!date) {
      expect(
        await expires.evaluate(
          (input: HTMLInputElement) => input.required && input.validity.valueMissing,
        ),
      ).toBe(true);
    }
    await form.getByRole("button", { name: "高级选项" }).click();
    await form.getByRole("button", { name: "创建空间" }).click();
    await expect(form.getByRole("alert")).toHaveText(error);
    await expect(expires).toBeFocused();
    await expect(expires).toHaveAttribute("aria-invalid", "true");
    await expect(expires).toHaveAccessibleDescription(error);
    await expect(name).toHaveValue("临时资料");
    await expires.fill("2099-01-01T12:00");
    await expect(form.getByRole("alert")).toHaveCount(0);
    await form.getByRole("button", { name: "创建空间" }).click();
    await expect(page).toHaveURL(/\/manage$/u);
  });
}

test("a confirmed save preserves newer name and expiry drafts", async ({ page }) => {
  await openFieldWorkspace(page);
  const created = await page.request.post("/api/v1/workspaces", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: "原名称", origin: "delivery", retention: "temporary", expiresAt: 4070908800 },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const path = `/api/v1/workspaces/${id}`;
  await page.goto(`/workspaces/${id}/manage`);
  const form = page.getByRole("form", { name: "空间设置" });
  const name = form.getByLabel("空间名称");
  const date = form.getByLabel("到期时间");
  const save = form.getByRole("button", { name: "保存空间设置" });
  await expect(save).toBeDisabled();
  const originalExpiry = await date.inputValue();
  await date.fill("2000-01-01T12:00");
  await expect(form.getByRole("alert")).toHaveText("到期时间必须晚于现在。");
  await expect(save).toBeDisabled();
  await date.fill(originalExpiry);
  await expect(form.getByRole("alert")).toBeHidden();
  await name.fill("临时改动");
  await expect(save).toBeEnabled();
  await name.fill(" 原名称 ");
  await expect(save).toBeDisabled();
  await name.fill("已提交名称");
  await date.fill("2098-02-01T12:00");

  let confirmedName = "";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    path,
    async (route) => {
      const response = await route.fetch();
      confirmedName = ((await response.json()) as { name: string }).name;
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );

  await save.click();
  try {
    await expect.poll(() => confirmedName).toBe("已提交名称");
    await name.fill("后续草稿");
    await date.fill("2099-03-01T12:00");
  } finally {
    release();
  }
  await expect(page.getByRole("heading", { name: "已提交名称" })).toBeVisible();
  await expect(name).toHaveValue("后续草稿");
  await expect(date).toHaveValue("2099-03-01T12:00");
  await expect(form.getByText("空间设置已保存")).toHaveCount(0);
  await save.click();
  await expect(form.getByText("空间设置已保存")).toBeVisible();
  await expect(save).toBeDisabled();
  await form.getByRole("button", { name: /保留方式/ }).click();
  await page.getByRole("option", { name: "长期保存" }).click();
  await expect(form.getByText("空间设置已保存")).toHaveCount(0);
  await page.reload();
  await expect(name).toHaveValue("后续草稿");
  await expect(date).toHaveValue("2099-03-01T12:00");
});

test("a failed settings save keeps the draft ready for retry", async ({ page }) => {
  await openFieldWorkspace(page);
  const created = await page.request.post("/api/v1/workspaces", {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name: "保存失败重试",
      origin: "delivery",
      retention: "temporary",
      expiresAt: 4070908817,
    },
  });
  expect(created.status()).toBe(201);
  const space = (await created.json()) as { id: string };
  await page.goto(`/workspaces/${space.id}/manage`);
  const form = page.getByRole("form", { name: "空间设置" });
  const name = form.getByLabel("空间名称");
  const save = form.getByRole("button", { name: "保存空间设置" });
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addStyleTag({ content: "html { font-size: 200% }" });
  expect(
    await save.evaluate((button) => {
      const text = document.createRange();
      text.selectNodeContents(button);
      return text.getClientRects().length;
    }),
  ).toBe(1);
  await name.fill("重试保存");
  await page.route(`/api/v1/workspaces/${space.id}`, (route) => route.fulfill({ status: 503 }), {
    times: 1,
  });
  await save.click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(name).toHaveValue("重试保存");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(form.getByText("空间设置已保存")).toBeVisible();
  await expect(save).toBeDisabled();
  const spaces = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    id: string;
    expiresAt: number | null;
  }[];
  expect(spaces.find(({ id }) => id === space.id)?.expiresAt).toBe(4070908817);
});
