import { expect, test } from "@playwright/test";
import type { components } from "../../src/api/schema.gen";
import { createNote, openDocumentTool } from "./productFixture";

type History = components["schemas"]["DocumentHistory"];

test("reads a saved diff and restores it as a new Git commit", async ({ page }) => {
  const original = "---\ntitle: 历史测试\n---\n\n初始稿  \r\n";
  // Other workers write to the shared spaces and restart their Git archive quiet period.
  const { apiUrl, document } = await createNote(
    page,
    "HistoryRoundTrip.md",
    original,
    "版本归档用例",
  );
  const history = async () =>
    (await (await page.request.get(`${apiUrl}/revisions`)).json()) as History;
  await expect.poll(async () => (await history()).revisions?.length, { timeout: 10_000 }).toBe(1);
  const initialCommit = (await history()).revisions[0]?.commitId;
  expect(initialCommit).toBeDefined();
  await openDocumentTool(page, "版本");
  const panel = page.getByRole("region", { name: "版本历史" });
  await expect(panel.getByRole("button", { name: /Create HistoryRoundTrip.md/ })).toBeVisible();
  await expect(panel.getByText("当前修改等待归档")).toHaveCount(0);

  await page.getByRole("article").getByText("初始稿").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await editor.press("Control+End");
  await page.keyboard.insertText("编辑的新版本");
  await expect(page.getByText("已保存")).toBeVisible();
  await expect(panel.getByText("当前修改等待归档")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article")).toContainText("编辑的新版本");

  await panel.getByRole("button", { name: /Create HistoryRoundTrip.md/ }).click();
  await expect(panel.getByLabel("版本差异")).toContainText("+初始稿");
  await panel.getByRole("button", { name: "恢复这一版" }).click();
  await expect(page.getByRole("article")).not.toContainText("编辑的新版本");

  const newHistory = await history();
  expect(newHistory.revisions).toHaveLength(3);
  expect(newHistory.revisions[0]?.message).toBe("Restore document version");
  expect(newHistory.revisions[2]?.commitId).toBe(initialCommit);
  const restored = (await (await page.request.get(apiUrl)).json()) as typeof document;
  expect(restored.markdown).toBe(original);
  expect(restored.revision).toBe(document.revision);
});
