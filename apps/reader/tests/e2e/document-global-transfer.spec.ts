import { expect } from "@playwright/test";
import { test } from "./managedMaterialsFixture";
import { createNote } from "./productFixture";
import type { Workspace } from "../../src/api/client";

test("reviews a cross-space copy, checks the original, and comes back to the pending decision", async ({
  page,
}, info) => {
  const { document: note, origin } = await createNote(
    page,
    "野外记录.md",
    "# 野外记录\n\n样点编号 42。",
  );
  const target = await page.request.post("/api/v1/workspaces", {
    headers: { origin },
    data: { name: "调查归档" },
  });
  expect(target.status()).toBe(201);
  const destination = (await target.json()) as Workspace;
  await page.getByRole("banner").getByRole("button", { name: "AI", exact: true }).click();
  const form = page.getByRole("form", { name: "AI 请求" });
  await form.getByRole("textbox", { name: "提示词" }).fill("请把野外记录复制到调查归档。");
  await form.getByRole("button", { name: /发送模式/ }).click();
  await page.getByRole("option", { name: "修改与管理", exact: true }).click();
  const queued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: "发送", exact: true }).click();
  expect((await queued).status()).toBe(202);
  const headers = {
    authorization: "Bearer synthetic-material-fixture-token",
    "x-librarian-runner-id": "material-fixture",
  };
  const claims = "/api/v1/ai/runner/v2/claims";
  const claim = await page.request.post(claims, { headers, data: {} });
  expect(claim.status()).toBe(200);
  const { leaseId } = (await claim.json()) as { leaseId: string };
  const submitted = await page.request.put(`${claims}/${leaseId}/result`, {
    headers,
    data: {
      answer: "请核对复制位置。",
      edits: [],
      sourceIds: [],
      action: {
        kind: "copy",
        sourceWorkspaceId: note.document.workspaceId,
        sourcePath: note.path,
        documentId: note.document.id,
        targetWorkspaceId: destination.id,
        targetPath: "归档记录.md",
      },
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(200);
  const plan = page.getByRole("region", { name: "待确认的操作" });
  const source = plan.getByRole("link", { name: /田野笔记.*野外记录.md/u });
  const confirm = plan.getByRole("button", { name: "确认复制" });
  await expect(confirm).toBeVisible();
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await confirm.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const path = info.outputPath("transfer-preview-" + width + ".png");
    await page.screenshot({ path });
    await info.attach("复制预览-" + width, { path, contentType: "image/png" });
  }
  const draft = form.getByRole("textbox", { name: "提示词" });
  await draft.fill("下一步核对时间。");
  const send = form.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeDisabled();
  await source.click();
  await expect(page.getByRole("article")).toContainText("样点编号 42。");
  await page.goBack();
  await expect(source).toBeFocused();
  await expect(draft).toHaveValue("下一步核对时间。");
  await confirm.focus();
  await page.keyboard.press("Enter");
  const receipt = page.getByRole("region", { name: "操作回执" });
  const copy = receipt.getByRole("link", { name: /调查归档.*归档记录.md/u });
  await expect(copy).toBeFocused();
  await expect(send).toBeEnabled();
  const href = await copy.getAttribute("href");
  expect(href).toContain("/workspaces/" + destination.id + "/documents/");
  expect(href).not.toContain(note.document.id);
  const path = info.outputPath("transfer-receipt.png");
  await page.screenshot({ path });
  await info.attach("复制回执", { path, contentType: "image/png" });
  await copy.click();
  await expect(page.getByRole("article")).toContainText("样点编号 42。");
  await page.goBack();
  await expect(copy).toBeFocused();
  await expect(draft).toHaveValue("下一步核对时间。");
});
