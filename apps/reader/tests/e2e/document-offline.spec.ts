import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Route } from "@playwright/test";
import type {
  DeliveryReceipt,
  DocumentSummary,
  SnapshotLink,
  Workspace,
} from "../../src/api/client";
import { openFieldWorkspace } from "./productFixture";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4n8AAAAASUVORK5CYII=";

async function offlineFixture(page: Page, deliveryId: string) {
  await openFieldWorkspace(page);
  const headers = { origin: new URL(page.url()).origin };
  const created = await page.request.post("/api/v1/workspaces", {
    headers,
    data: { name: `离线浏览器测试 ${deliveryId}` },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as Workspace;
  const workspaceApi = `/api/v1/workspaces/${workspace.id}`;
  const delivered = await page.request.post(`${workspaceApi}/deliveries`, {
    headers,
    data: {
      manifest: { deliveryId, sourceName: "离线测试" },
      files: [
        {
          path: "01.md",
          contentBase64: Buffer.from(
            "# 离线固定稿\n\n[下一篇](02.md)\n\n![像素](pixel.png)\n",
          ).toString("base64"),
        },
        {
          path: "02.md",
          contentBase64: Buffer.from("# 离线第二篇\n").toString("base64"),
        },
        { path: "pixel.png", contentBase64: pixel },
      ],
    },
  });
  expect(delivered.ok()).toBe(true);
  const { commitId } = (await delivered.json()) as DeliveryReceipt;
  const documents = (await (
    await page.request.get(`${workspaceApi}/documents`)
  ).json()) as DocumentSummary[];
  const selected = documents.filter(({ path }) => path.startsWith(`deliveries/${deliveryId}/`));
  expect(selected).toHaveLength(2);

  async function snapshot(
    kind: "release" | "current" = "release",
    audience: "members" | "share" = "members",
  ) {
    const response = await page.request.post(`${workspaceApi}/snapshots`, {
      headers,
      data: {
        kind,
        audience,
        documentIds: selected.map(({ id }) => id),
        attachmentPaths: [`deliveries/${deliveryId}/pixel.png`],
        ...(kind === "release" && { commitId }),
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()) as SnapshotLink;
  }

  async function save(address: SnapshotLink) {
    await page.goto(address.url);
    await expect(page.getByRole("article")).toContainText("离线固定稿");
    await page.getByRole("button", { name: "保存离线副本" }).click();
    await expect(page.getByText("已保存离线副本", { exact: true })).toBeVisible();
  }

  return { headers, workspace, selected, snapshot, save };
}

function canRead(page: Page, endpoint: string) {
  return page.evaluate(async (path) => {
    try {
      return (await fetch(path, { cache: "no-store" })).ok;
    } catch {
      return false;
    }
  }, endpoint);
}

async function disconnect(context: BrowserContext) {
  const blocked = new Set<string>();
  const blockWorker = async (route: Route) => {
    if (route.request().serviceWorker()) {
      blocked.add(new URL(route.request().url()).pathname);
      await route.abort("internetdisconnected");
    } else {
      await route.fallback();
    }
  };
  await context.route("**/*", blockWorker);
  await context.setOffline(true);
  return {
    blocked,
    async reconnect() {
      await context.setOffline(false);
      await context.unroute("**/*", blockWorker);
    },
  };
}

test("only an explicitly saved fixed address and its assets open after a direct offline navigation", async ({
  page,
  context,
}) => {
  const fixture = await offlineFixture(page, "offline-scope");
  const saved = await fixture.snapshot();
  const unsaved = await fixture.snapshot();
  const current = await fixture.snapshot("current");
  await page.goto(current.url);
  await expect(page.getByRole("article")).toContainText("离线固定稿");
  await expect(page.getByRole("button", { name: "保存离线副本" })).toHaveCount(0);
  await fixture.save(saved);

  const visitor = await context.newPage();
  await visitor.setViewportSize({ width: 360, height: 780 });
  await visitor.emulateMedia({ reducedMotion: "reduce" });
  const network = await disconnect(context);
  try {
    await visitor.goto(saved.url);
    await expect(visitor.getByRole("article")).toContainText("离线固定稿");
    await expect(visitor.getByText("正在读取离线副本")).toBeVisible();
    expect(network.blocked.has(`/api/v1/snapshots/${saved.id}`)).toBe(true);
    expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    const image = visitor.getByRole("img", { name: "像素" });
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(1);
    await visitor.getByRole("link", { name: "下一篇" }).click();
    await expect(visitor.getByRole("article")).toContainText("离线第二篇");
    expect(await canRead(visitor, `/api/v1/snapshots/${unsaved.id}`)).toBe(false);
    expect(await canRead(visitor, `/api/v1/documents/${fixture.selected[0]?.id}`)).toBe(false);
    expect(await canRead(visitor, `/api/v1/workspaces/${fixture.workspace.id}/search?q=离线`)).toBe(
      false,
    );
  } finally {
    await network.reconnect();
    await visitor.close();
  }
});

test("an online revocation defeats a saved response and removes its offline fallback", async ({
  page,
  context,
}) => {
  const fixture = await offlineFixture(page, "offline-revoked");
  const saved = await fixture.snapshot();
  await fixture.save(saved);
  const endpoint = `/api/v1/snapshots/${saved.id}`;

  // Playwright API requests bypass the worker, just like a second client.
  const revoked = await page.request.delete(endpoint, { headers: fixture.headers });
  expect(revoked.status()).toBe(204);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("阅读地址不可用");
  const network = await disconnect(context);
  try {
    expect(await canRead(page, endpoint)).toBe(false);
  } finally {
    await network.reconnect();
  }
});

test("signing out clears saved member snapshots before opening the login page", async ({
  page,
  context,
}) => {
  const fixture = await offlineFixture(page, "offline-logout");
  const saved = await fixture.snapshot();
  await fixture.save(saved);
  await page.goto(`/workspaces/${fixture.workspace.id}`);
  await page.getByRole("button", { name: "搜索文档" }).click();
  const logout = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/session/logout") && response.request().method() === "POST",
  );
  await page.getByRole("option", { name: "退出登录", exact: true }).click();
  expect((await logout).status()).toBe(204);
  await expect(page).toHaveURL(/\/\.auth\/librarian\/login/);
  expect((await page.request.get("/api/v1/session")).status()).toBe(401);
  const network = await disconnect(context);
  try {
    expect(await canRead(page, `/api/v1/snapshots/${saved.id}`)).toBe(false);
  } finally {
    await network.reconnect();
  }
});

test("a newly signed-in account loses the previous account's saved snapshots", async ({
  page,
  context,
}) => {
  const fixture = await offlineFixture(page, "offline-switch");
  const saved = await fixture.snapshot();
  await fixture.save(saved);

  await page.goto("/.auth/librarian/login");
  await page.getByLabel("用户名").fill("offline-reader");
  await page.getByLabel("密码").fill("offline-reader-test-password");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/.auth/librarian/login"),
    ),
    page.getByRole("button", { name: "登录" }).click(),
  ]);
  await expect(page).toHaveURL(/\/workspaces\/[^/]+\/documents\/[^/]+/);
  const session = await page.request.get("/api/v1/session");
  expect(session.ok()).toBe(true);
  expect(await session.json()).toMatchObject({ username: "offline-reader" });

  // Observe the account boundary before probing the saved URL, so a denial of the
  // snapshot itself cannot account for the cache removal.
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await caches.keys()).some((name) => name.endsWith(id)),
        saved.id,
      ),
    )
    .toBe(false);
  const network = await disconnect(context);
  try {
    expect(await canRead(page, `/api/v1/snapshots/${saved.id}`)).toBe(false);
  } finally {
    await network.reconnect();
  }
});
