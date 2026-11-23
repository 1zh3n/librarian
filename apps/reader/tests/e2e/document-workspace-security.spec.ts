import { expect, test } from "@playwright/test";
import { openFieldWorkspace } from "./productFixture";

async function createWorkspace(page: import("@playwright/test").Page, name: string) {
  const created = await page.request.post("/api/v1/workspaces", {
    headers: { origin: new URL(page.url()).origin },
    data: { name },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string };
}

test("changes a workspace security level with a downgrade confirmation", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFieldWorkspace(page);
  const workspace = await createWorkspace(page, "安全等级验收");
  await page.goto(`/workspaces/${workspace.id}/manage`);

  const section = page.getByRole("region", { name: "安全等级" });
  await page.screenshot({ path: testInfo.outputPath("security-1440.png"), fullPage: true });
  await expect(section.getByText("内部").first()).toBeVisible();
  const aiRow = section.locator("dt").filter({ hasText: "外部 AI" }).locator("..");
  await expect(aiRow).toContainText("允许");
  await expect(section.getByRole("button", { name: "保存安全等级" })).toBeDisabled();

  await section.getByRole("button", { name: "内部 安全等级" }).click();
  await page.getByRole("option", { name: "受限", exact: true }).click();
  await expect(section.getByRole("button", { name: "保存安全等级" })).toBeEnabled();
  await section.getByRole("button", { name: "保存安全等级" }).click();
  await expect(section.getByText("安全等级已保存")).toBeVisible();
  await expect(section.getByText("受限").first()).toBeVisible();
  await expect(aiRow).toContainText("关闭");
  const afterSave = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    id: string;
    securityLevel: string;
  }[];
  expect(afterSave.find((item) => item.id === workspace.id)?.securityLevel).toBe("confidential");

  const created = await page.request.post(`/api/v1/workspaces/${workspace.id}/documents`, {
    headers: { origin: new URL(page.url()).origin },
    data: { path: "Note.md", markdown: "# Note\n", baseRevision: null },
  });
  expect(created.status()).toBe(201);
  const document = (await created.json()) as { document: { id: string } };
  await page.goto(`/workspaces/${workspace.id}/documents/${document.document.id}`);
  await expect(page.getByRole("button", { name: /切换空间，当前为安全等级验收/u })).toContainText(
    "受限",
  );
  await expect(page.getByRole("button", { name: "外部 AI 已关闭" })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("security-document-1440.png"),
    fullPage: true,
  });

  await page.goto(`/workspaces/${workspace.id}/manage`);
  const sectionAfterDocument = page.getByRole("region", { name: "安全等级" });
  await sectionAfterDocument.getByRole("button", { name: "受限 安全等级" }).click();
  await page.getByRole("option", { name: "内部", exact: true }).click();
  await sectionAfterDocument.getByRole("button", { name: "保存安全等级" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("降低安全等级？")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("security-confirm-1440.png") });
  await dialog.getByRole("button", { name: "降低等级" }).click();
  await expect(sectionAfterDocument.getByText("安全等级已保存")).toBeVisible();
  await expect(sectionAfterDocument.getByText("内部").first()).toBeVisible();

  const spaces = (await (await page.request.get("/api/v1/workspaces")).json()) as {
    id: string;
    securityLevel: string;
  }[];
  expect(spaces.find((item) => item.id === workspace.id)?.securityLevel).toBe("internal");
});

test("the security section reflows at 390 and 320 with 200% text", async ({ page }, testInfo) => {
  await openFieldWorkspace(page);
  const workspace = await createWorkspace(page, "安全等级窄屏");
  const raised = await page.request.patch(`/api/v1/workspaces/${workspace.id}`, {
    headers: { origin: new URL(page.url()).origin },
    data: { securityLevel: "confidential" },
  });
  expect(raised.ok()).toBe(true);
  await page.goto(`/workspaces/${workspace.id}/manage`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("region", { name: "安全等级" })).toBeVisible();
  await expect(page.locator("header").getByText("受限").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("security-390.png"), fullPage: true });

  await page.setViewportSize({ width: 320, height: 760 });
  await page.addStyleTag({ content: "html { font-size: 200% }" });
  await expect(page.getByRole("region", { name: "安全等级" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath("security-320-200.png"), fullPage: true });
  const save = page.getByRole("button", { name: "保存安全等级" });
  const box = await save.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(320);
});
