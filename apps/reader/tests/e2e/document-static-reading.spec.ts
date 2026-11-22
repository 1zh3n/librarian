import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createNote, openFieldWorkspace } from "./productFixture";

const png = readFileSync(new URL("../../../../server/testdata/images/tiny.png", import.meta.url));

const encodePath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

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
  const uploadedAsset = (await uploaded.json()) as { path: string };
  const first = await createNote(
    page,
    "静态阅读/起点.md",
    "# 静态阅读\n\n[下一篇](终点.md)\n\n| 列 | 值 |\n| --- | ---: |\n| 一 | 二 |\n\n```rust\nfn main() {}\n```\n\n![河岸](assets/photo.png)\n",
  );
  const second = await createNote(page, "静态阅读/终点.md", "# 终点\n\n这是终点正文。\n");
  const snapshot = await page.request.post(`/api/v1/workspaces/${workspace.id}/snapshots`, {
    headers: { origin },
    data: {
      kind: "current",
      audience: "share",
      documentIds: [first.document.document.id, second.document.document.id],
      attachmentPaths: [uploadedAsset.path],
    },
  });
  expect(snapshot.status()).toBe(201);
  const share = await snapshot.json();
  const storageState = await page.context().storageState();

  const privateContext = await browser.newContext({
    baseURL: origin,
    javaScriptEnabled: false,
    storageState,
    viewport: { width: 1440, height: 900 },
  });
  const privatePage = await privateContext.newPage();
  try {
    const privateUrl = `/workspaces/${workspace.id}/documents/${first.document.document.id}/read`;
    await privatePage.goto(`/workspaces/${workspace.id}/documents/${first.document.document.id}`);
    await expect(privatePage.getByRole("link", { name: "静态阅读版" })).toHaveAttribute(
      "href",
      privateUrl,
    );
    await privatePage.getByRole("link", { name: "静态阅读版" }).click();
    await expect(privatePage.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(privatePage.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(privatePage.locator("h1")).toHaveCount(1);
    await expect(privatePage.locator("article img")).toHaveCount(1);
    await expect(privatePage.locator("article img")).toHaveAttribute(
      "src",
      `/api/v1/workspaces/${workspace.id}/assets/${encodePath(uploadedAsset.path)}`,
    );
    await expect(privatePage.getByRole("link", { name: "下一篇" })).toHaveAttribute(
      "href",
      `/workspaces/${workspace.id}/documents/${second.document.document.id}/read`,
    );
    await expect(privatePage.getByRole("table")).toBeVisible();
    await expect(privatePage.locator("article pre code")).toContainText("fn main() {}");
    await expect(privatePage.locator("script")).toHaveCount(0);
    await expect(privatePage.locator("html")).not.toHaveClass(/eink/);
    await expect(privatePage.locator("body")).toContainText("下一篇");
    expect(
      await privatePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await privatePage.screenshot({ path: "test-results/static-private-1440.png" });

    const einkUrl = `${privateUrl}?eink=1&theme=light`;
    await privatePage.goto(einkUrl);
    await expect(privatePage.locator("html")).toHaveClass(/eink/);
    await expect(privatePage.locator("html")).toHaveClass(/theme-light/);
    await privatePage.setViewportSize({ width: 390, height: 844 });
    expect(
      await privatePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await privatePage.screenshot({ path: "test-results/static-private-390-eink.png" });

    await privatePage.setViewportSize({ width: 320, height: 720 });
    await privatePage.goto(`${einkUrl}&text=200`);
    await expect(privatePage.locator("html")).toHaveClass(/text-200/);
    expect(
      await privatePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await privatePage.screenshot({ path: "test-results/static-private-320-text-200-eink.png" });

    await privatePage.emulateMedia({ media: "print" });
    await expect(privatePage.locator(".page-footer")).toBeHidden();
    await expect(privatePage.locator("article h1")).toBeVisible();
  } finally {
    await privateContext.close();
  }

  const shareContext = await browser.newContext({
    baseURL: origin,
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const sharePage = await shareContext.newPage();
  try {
    await sharePage.goto(`/r/${share.id}`);
    await expect(sharePage.getByRole("link", { name: "静态阅读版" })).toHaveAttribute(
      "href",
      `/r/${share.id}/read`,
    );
    await sharePage.getByRole("link", { name: "静态阅读版" }).click();
    await expect(sharePage.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(sharePage.getByRole("navigation", { name: "阅读地址中的文档" })).toBeVisible();
    await expect(sharePage.getByRole("heading", { name: "静态阅读", level: 1 })).toBeVisible();
    await expect(sharePage.getByRole("navigation", { name: "阅读地址中的文档" })).toBeVisible();
    await expect(sharePage.getByRole("link", { name: "终点" })).toHaveAttribute(
      "href",
      `/r/${share.id}/read?documentId=${second.document.document.id}`,
    );
    await expect(sharePage.locator("article img")).toHaveAttribute(
      "src",
      `/api/v1/snapshots/${share.id}/assets/${encodePath(uploadedAsset.path)}`,
    );
    await expect(sharePage.locator("script")).toHaveCount(0);
    expect(
      await sharePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await sharePage.screenshot({ path: "test-results/static-share-1440.png" });
    await sharePage.getByRole("link", { name: "终点" }).click();
    await expect(sharePage.getByRole("heading", { name: "终点", level: 1 })).toBeVisible();
    await expect(sharePage.locator("body")).toContainText("这是终点正文。");
    await expect(sharePage.getByRole("link", { name: "终点" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await sharePage.emulateMedia({ media: "print" });
    await expect(sharePage.getByRole("navigation", { name: "阅读地址中的文档" })).toBeHidden();
    await expect(sharePage.locator(".page-footer")).toBeHidden();
    await expect(sharePage.getByRole("heading", { name: "终点", level: 1 })).toBeVisible();
    await sharePage.screenshot({ path: "test-results/static-share-print.png" });
  } finally {
    await shareContext.close();
  }
});
