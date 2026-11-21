import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { DocumentSnapshot, DocumentSummary, Workspace } from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

async function createWorkspace(page: Page, name: string, temporary = false) {
  await openFieldWorkspace(page);
  const navigation = page.locator("#workspace-navigation");
  if ((page.viewportSize()?.width ?? 1_280) <= 800) {
    await page.getByRole("button", { name: "展开目录" }).click();
  }
  const chooser = navigation.getByRole("button", { name: /空间/ }).first();
  await chooser.press("Enter");
  await page.getByRole("option", { name: "新建空间" }).click();
  const form = page.getByRole("form", { name: "新建空间" });
  await form.getByRole("textbox", { name: "空间名称" }).fill(name);
  if (temporary) {
    await form.getByRole("button", { name: /空间来源/ }).click();
    await page.getByRole("option", { name: "投递" }).click();
    await form.getByRole("button", { name: /保留方式/ }).click();
    await page.getByRole("option", { name: "临时保存" }).click();
    const expires = await page.evaluate(() => {
      const date = new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    });
    await form.getByLabel("到期时间").fill(expires);
  }
  await form.getByRole("button", { name: "创建空间" }).click();
  await expect(page).toHaveURL(/\/workspaces\/[^/]+\/manage$/);
  const workspaces = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  const workspace = workspaces.find((item) => item.name === name);
  if (!workspace) throw new Error("Created Workspace is missing from the account");
  return workspace;
}

async function addDocument(page: Page, workspace: string, path: string, markdown: string) {
  const response = await page.request.post(`/api/v1/workspaces/${workspace}/documents`, {
    headers: { origin: new URL(page.url()).origin },
    data: { path, markdown, baseRevision: null },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as DocumentSnapshot;
}

test("creates and keeps a temporary Workspace at 360 px without changing its address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const workspace = await createWorkspace(page, "浏览器临时空间", true);
  const settings = page.getByRole("form", { name: "空间设置" });
  await settings.getByRole("textbox", { name: "空间名称" }).fill("浏览器长期空间");
  await settings.getByRole("button", { name: /保留方式/ }).click();
  await page.getByRole("option", { name: "长期保存" }).click();
  await settings.getByRole("button", { name: "保存空间设置" }).click();
  await expect(page.getByRole("heading", { name: "浏览器长期空间" })).toBeVisible();
  await page.reload();
  await expect(settings.getByRole("textbox", { name: "空间名称" })).toHaveValue("浏览器长期空间");
  const persisted = (await (await page.request.get("/api/v1/workspaces")).json()) as Workspace[];
  expect(persisted.find((item) => item.id === workspace.id)).toMatchObject({
    name: "浏览器长期空间",
    retention: "persistent",
    expiresAt: null,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
});

test("renaming a directory keeps the original document deep link", async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(Crypto.prototype, "randomUUID"));
  const workspace = await createWorkspace(page, "浏览器路径工作台");
  const document = await addDocument(page, workspace.id, "初始目录/记录.md", "# 路径保留\n");
  const deepLink = `/workspaces/${workspace.id}/documents/${document.document.id}`;
  await page.goto(deepLink);
  await expect(page.getByRole("article")).toContainText("路径保留");
  await page.getByRole("button", { name: "空间设置" }).click();
  const rename = page.getByRole("form", { name: "重命名路径" });
  await rename.getByRole("textbox", { name: "原路径" }).fill("初始目录");
  await rename.getByRole("textbox", { name: "新路径" }).fill("归档目录");
  await rename.getByRole("button", { name: "重命名" }).click();
  await expect(rename.getByText("路径已更新")).toBeVisible();
  await page.goto(deepLink);
  await expect(page.getByRole("article")).toContainText("路径保留");
  const snapshot = (await (
    await page.request.get(`/api/v1/documents/${document.document.id}`)
  ).json()) as DocumentSnapshot;
  expect(snapshot.document.path).toBe("归档目录/记录.md");
});

const deliveryZip =
  "UEsDBBQAAAAIACc7dV2GyQopKAAAACUAAAAPAAAAZ3VpZGVzL3N0YXJ0Lm1kU1Z4smvJs76lz3a0Pu2dysWlGP20uf/5lgWxGgWZFak5egV56ZpcAFBLAwQUAAAACAAnO3VdGgJwhz8AAABEAAAAEAAAAGd1aWRlcy9waXhlbC5wbmfrDPBz5+WS4mJgYOD19HAJAtKMIMzBAiS3yvAwASluTxfHkIpbyX/+yzMwMzMxvF/8qB4ozODp6ueyzimhCQBQSwECFAMUAAAACAAnO3VdhskKKSgAAAAlAAAADwAAAAAAAAAAAAAAgAEAAAAAZ3VpZGVzL3N0YXJ0Lm1kUEsBAhQDFAAAAAgAJzt1XRoCcIc/AAAARAAAABAAAAAAAAAAAAAAAIABVQAAAGd1aWRlcy9waXhlbC5wbmdQSwUGAAAAAAIAAgB7AAAAwgAAAAAA";

async function selectDeliveryFile(
  page: Page,
  form: Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const pick = form.getByRole("button", { name: "选择文件", exact: true });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), pick.click()]);
  await chooser.setFiles(file);
}

test("uploads a ZIP and keeps its receipt and readable relative attachment", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器投递清单");
  const form = page.getByRole("form", { name: "投递文件" });
  await form.getByRole("textbox", { name: "投递 ID" }).fill("browser-release");
  await form.getByRole("textbox", { name: "来源名称" }).fill("浏览器交付");
  await selectDeliveryFile(page, form, {
    name: "oversized.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(12 * 1024 * 1024 + 1),
  });
  await expect(form.getByRole("alert")).toContainText("投递文件超过大小限制");
  await expect(form.getByRole("button", { name: "上传投递" })).toBeDisabled();
  await selectDeliveryFile(page, form, {
    name: "delivery.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(deliveryZip, "base64"),
  });
  await form.getByRole("button", { name: "上传投递" }).click();
  const history = page.getByRole("region", { name: "投递记录" });
  await expect(history).toContainText("浏览器交付");
  await expect(history).toContainText("browser-release");
  await page.reload();
  await expect(history).toContainText("browser-release");

  const documents = (await (
    await page.request.get(`/api/v1/workspaces/${workspace.id}/documents`)
  ).json()) as DocumentSummary[];
  const document = documents.find((item) => item.path.endsWith("/guides/start.md"));
  if (!document) throw new Error("Delivered Markdown was not indexed");
  await page.goto(`/workspaces/${workspace.id}/documents/${document.id}`);
  const image = page.getByRole("article").getByRole("img", { name: "像素" });
  await expect.poll(() => image.evaluate((value: HTMLImageElement) => value.naturalWidth)).toBe(1);
});

test("creates a note from an empty Workspace and starts writing", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器新建文档");
  await page.goto(`/workspaces/${workspace.id}`);
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await dialog.getByRole("textbox", { name: "文档名称" }).fill("我的第一份笔记");
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toBeFocused();
  await expect(page).toHaveURL(/\/documents\/doc_/u);
  await expect(page.getByRole("row", { name: "我的第一份笔记" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("keeps an unsaved draft when the reader declines to open the new note", async ({ page }) => {
  const workspace = await createWorkspace(page, "浏览器新建与草稿");
  const current = await addDocument(page, workspace.id, "当前笔记.md", "原文内容\n");
  const currentRoute = `/workspaces/${workspace.id}/documents/${current.document.id}`;
  await page.goto(currentRoute);
  await page.getByRole("article").getByText("原文内容").click();
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  await expect(editor).toBeFocused();
  await page.route(`**/api/v1/documents/${current.document.id}`, async (route) => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 503 });
    else await route.continue();
  });
  await page.keyboard.insertText("保留的本地草稿");
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await dialog.getByRole("textbox", { name: "文档名称" }).fill("稍后阅读");
  page.once("dialog", (prompt) => prompt.dismiss());
  await dialog.getByRole("button", { name: "创建文档" }).click();
  await expect(page.getByText("已新建「稍后阅读」。可在目录中打开。")).toBeVisible();
  await expect(page).toHaveURL(currentRoute);
  await expect(editor).toContainText("保留的本地草稿");
  const created = page.getByRole("row", { name: "稍后阅读" });
  await expect(created).toBeVisible();
  page.once("dialog", (prompt) => prompt.accept());
  await created.click();
  await expect(page.getByRole("heading", { name: "稍后阅读", level: 1 })).toBeVisible();
  await expect(editor).toHaveCount(0);
});

test("a share snapshot reads the selected documents anonymously and revokes the same address", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "浏览器共享阅读");
  const start = await addDocument(
    page,
    workspace.id,
    "共享/起点.md",
    "# 起点\n\n[去终点](终点.md) [去私稿](私稿.md)\n\n<script>should-not-render</script>\n",
  );
  await addDocument(page, workspace.id, "共享/终点.md", "# 终点\n");
  await addDocument(page, workspace.id, "共享/私稿.md", "# 私稿\n");
  await page.reload();
  const snapshot = page.getByRole("form", { name: "创建阅读地址" });
  for (const path of ["共享/起点.md", "共享/终点.md"]) {
    await snapshot.getByText(path, { exact: true }).click();
    await expect(snapshot.getByRole("checkbox", { name: path })).toBeChecked();
  }
  await snapshot.getByRole("button", { name: /访问范围/ }).click();
  await page.getByRole("option", { name: "持链接可读" }).click();
  await snapshot.getByRole("button", { name: "创建阅读地址" }).click();
  const address = page.getByRole("link", { name: "打开阅读地址" });
  await expect(address).toBeVisible();
  const href = await address.getAttribute("href");
  if (!href) throw new Error("Snapshot address missing");
  const visitor = await browser.newPage();
  const workspaceRequests: string[] = [];
  visitor.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/workspaces")
      workspaceRequests.push(request.url());
  });
  try {
    await visitor.goto(new URL(href, page.url()).href);
    const article = visitor.getByRole("article");
    await expect(article).toContainText("起点");
    await expect(visitor.getByRole("button", { name: "文档 AI" })).toHaveCount(0);
    expect(workspaceRequests).toHaveLength(0);
    await expect(article.getByRole("link", { name: "去私稿" })).toHaveCount(0);
    await expect(article).not.toContainText("should-not-render");
    await article.getByRole("link", { name: "去终点" }).click();
    await expect(article).toContainText("终点");

    const update = await page.request.put(`/api/v1/documents/${start.document.id}`, {
      headers: { origin: new URL(page.url()).origin },
      data: { markdown: "# 起点已更新\n", baseRevision: start.revision },
    });
    expect(update.ok()).toBe(true);
    await visitor.goto(new URL(href, page.url()).href);
    await expect(article).toContainText("起点已更新");
    await page.getByRole("button", { name: "撤销阅读地址" }).click();
    await expect(page.getByText("阅读地址已撤销")).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole("alert")).toContainText("阅读地址不可用");
  } finally {
    await visitor.close();
  }
});

test("shows a delivery credential once and persists its revocation", async ({ page }) => {
  await createWorkspace(page, "浏览器投递凭证");
  const tokens = page.getByRole("region", { name: "投递凭证" });
  await tokens.getByRole("textbox", { name: "凭证名称" }).fill("文档 CI");
  await tokens.getByRole("textbox", { name: "投递 ID" }).fill("workspace-docs");
  await tokens.getByRole("button", { name: "签发凭证" }).click();
  const secret = tokens.getByRole("textbox", { name: "新签发的凭证" });
  await expect(secret).toBeVisible();
  await expect(secret).not.toHaveValue("");
  await page.reload();
  await expect(secret).toHaveCount(0);
  const token = tokens.getByRole("listitem").filter({ hasText: "文档 CI" });
  await token.getByRole("button", { name: "撤销凭证" }).click();
  await expect(token).toContainText("已撤销");
  await page.reload();
  await expect(token).toContainText("已撤销");
  await expect(secret).toHaveCount(0);
});

test("a fixed reading address preserves delivered Markdown and its selected attachment", async ({
  page,
  browser,
}) => {
  const workspace = await createWorkspace(page, "浏览器固定版本");
  const workspaceApi = `/api/v1/workspaces/${workspace.id}`;
  const origin = new URL(page.url()).origin;
  const packaged = await page.request.post(`${workspaceApi}/deliveries`, {
    headers: { origin },
    data: {
      manifest: { deliveryId: "published", sourceName: "固定版本来源" },
      archiveBase64: deliveryZip,
    },
  });
  expect(packaged.ok()).toBe(true);
  const receipt = (await packaged.json()) as { commitId: string };
  const documents = (await (
    await page.request.get(`${workspaceApi}/documents`)
  ).json()) as DocumentSummary[];
  const delivered = documents.find((item) => item.path.endsWith("/guides/start.md"));
  if (!delivered) throw new Error("Missing delivered note");
  await page.reload();
  const form = page.getByRole("form", { name: "创建阅读地址" });
  await form.getByText(delivered.path, { exact: true }).click();
  await expect(form.getByRole("checkbox", { name: delivered.path })).toBeChecked();
  await form.getByRole("button", { name: /地址类型/ }).click();
  await page.getByRole("option", { name: "固定版本" }).click();
  await form.getByRole("textbox", { name: "提交 ID（可选）" }).fill(receipt.commitId);
  await form.getByRole("button", { name: /访问范围/ }).click();
  await page.getByRole("option", { name: "持链接可读" }).click();
  await form
    .getByRole("textbox", { name: /附件路径/ })
    .fill("deliveries/published/guides/pixel.png");
  await form.getByRole("button", { name: "创建阅读地址" }).click();
  const address = page.getByRole("link", { name: "打开阅读地址" });
  await expect(address).toBeVisible();
  const href = await address.getAttribute("href");
  if (!href) throw new Error("Fixed address missing");

  const upload = page.getByRole("form", { name: "投递文件" });
  await upload.getByRole("textbox", { name: "投递 ID" }).fill("published");
  await upload.getByRole("textbox", { name: "来源名称" }).fill("固定版本来源");
  await upload.getByRole("textbox", { name: "版本（可选）" }).fill("2");
  await selectDeliveryFile(page, upload, {
    name: "start.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 新交接清单\n"),
  });
  await upload.getByRole("button", { name: "上传投递" }).click();
  await expect(page.getByRole("region", { name: "投递记录" })).toContainText("published · 2");
  const visitor = await browser.newPage();
  try {
    await visitor.goto(new URL(href, page.url()).href);
    const article = visitor.getByRole("article");
    await expect(article).toContainText("交接清单");
    await expect(article).not.toContainText("新交接清单");
    const pixel = article.getByRole("img", { name: "像素" });
    await expect(pixel).toHaveAttribute(
      "src",
      /\/api\/v1\/snapshots\/.+\/assets\/deliveries\/published\/guides\/pixel\.png$/,
    );
    await expect
      .poll(() => pixel.evaluate((value: HTMLImageElement) => value.naturalWidth))
      .toBe(1);
  } finally {
    await visitor.close();
  }
});
