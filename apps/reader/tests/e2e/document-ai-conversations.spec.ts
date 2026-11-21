import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createNote, openDocumentTool } from "./productFixture";

const claims = "/api/v1/ai/runner/claims";
const headers = { authorization: "Bearer reader-fixture-ai-token-only-for-tests" };
async function send(page: Page, question: string) {
  const form = page.getByRole("form", { name: "AI 请求" });
  await form.getByRole("textbox", { name: "提示词" }).fill(question);
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/turns$/u.test(r.url()),
  );
  await form.getByRole("button", { name: "询问", exact: true }).click();
  expect((await saved).status()).toBe(202);
  const claim = await page.request.post(claims, { headers });
  expect(claim.ok()).toBeTruthy();
  return (await claim.json()) as {
    leaseId: string;
    input: { history?: { prompt: string; answer: string }[] };
  };
}

test("follows_up_with_previous_message_after_reload", async ({ page }) => {
  await createNote(page, "恢复会话.md", "# 会话样本\n\n甲组记录。");
  await openDocumentTool(page, "AI");
  const first = await send(page, "请概括甲组记录");
  const result = await page.request.put(claims + "/" + first.leaseId + "/result", {
    headers,
    data: { answer: "**甲组的回答**", sourceIds: [], edits: [] },
  });
  expect(result.ok()).toBeTruthy();
  await expect(page.getByText("甲组的回答", { exact: true })).toBeVisible();
  await page.reload();
  if (!(await page.getByRole("form", { name: "AI 请求" }).isVisible()))
    await openDocumentTool(page, "AI");
  await expect(page.getByText("请概括甲组记录", { exact: true })).toBeVisible();
  const second = await send(page, "和乙组有什么差别？");
  expect(second.input.history).toEqual([{ prompt: "请概括甲组记录", answer: "**甲组的回答**" }]);
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByText("此 AI 操作已取消。")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试本轮" })).toBeVisible();
});
