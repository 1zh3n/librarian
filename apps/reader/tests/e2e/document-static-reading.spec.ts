import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createNote, openFieldWorkspace } from "./productFixture";

const png = readFileSync(new URL("../../../../server/testdata/images/tiny.png", import.meta.url));

test("serves private documents and share snapshots without JavaScript", async ({
  page,
  browser,
}) => {
  const workspace = await openFieldWorkspace(page);
  const origin = new URL(page.url()).origin;
  const uploaded = await page.request.post(`/api/v1/workspaces/${workspace.id}/assets`, {
    headers: { origin },
    multipart: {
      operationId: "11111111-2222-4333-8444-555555555555",
      targetDirectory: "静态阅读/assets",
      fileName: "photo.png",
      conflictPolicy: "reject",
      file: { name: "photo.png", mimeType: "image/png", buffer: png },
    },
  });
  expect(uploaded.status()).toBe(201);
  const first = await createNote(
    page,
    "静态阅读/起点.md",
    "# 静态阅读\n\n[下一篇](终点.md)\n\n![河岸](assets/photo.png)\n",
  );
  const second = await createNote(page, "静态阅读/终点.md", "# 终点\n\n这是终点正文。\n");
  const snapshot = await page.request.post(`/api/v1/workspaces/${workspace.id}/snapshots`, {
    headers: { origin },
    data: {
      kind: "current",
      audience: "share",
      documentIds: [first.document.document.id, second.document.document.id],
    },
  });
  expect(snapshot.status()).toBe(201);
  const share = await snapshot.json();

  const context = await browser.newContext({
    baseURL: origin,
    javaScriptEnabled: false,
    storageState: await page.context().storageState(),
    viewport: { width: 1440, height: 900 },
  });
  const noJs = await context.newPage();
  try {
    const privateUrl = `/workspaces/${workspace.id}/documents/${first.document.document.id}/read`;
    await noJs.goto(privateUrl);
    await expect(noJs.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(noJs.locator("article img")).toHaveCount(1);
    await expect(noJs.locator("article img")).toHaveAttribute(
      "src",
      `/api/v1/workspaces/${workspace.id}/assets/静态阅读/assets/photo.png`.replace(
        "静态阅读",
        encodeURIComponent("静态阅读"),
      ),
    );
    await expect(noJs.locator("script")).toHaveCount(0);
    await expect(noJs.locator("html")).not.toHaveClass(/eink/);
    await expect(noJs.locator("body")).toContainText("下一篇");
    await noJs.screenshot({ path: "test-results/static-private-1440.png" });

    const einkUrl = `${privateUrl}?eink=1&theme=light&text=200`;
    await noJs.goto(einkUrl);
    await expect(noJs.locator("html")).toHaveClass(/eink/);
    await expect(noJs.locator("html")).toHaveClass(/theme-light/);
    await expect(noJs.locator("html")).toHaveClass(/text-200/);
    await noJs.setViewportSize({ width: 390, height: 844 });
    await noJs.screenshot({ path: "test-results/static-private-390-eink.png" });

    await noJs.goto(`${origin}/r/${share.id}/read`);
    await expect(noJs.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(noJs.getByRole("navigation", { name: "阅读地址中的文档" })).toBeVisible();
    await expect(noJs.getByRole("link", { name: "终点" })).toHaveAttribute(
      "href",
      `/r/${share.id}/read?documentId=${second.document.document.id}`,
    );
    await expect(noJs.locator("script")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
