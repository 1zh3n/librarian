import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function alignBlock(block: Locator) {
  await block.evaluate((element) => {
    const viewport = element.closest<HTMLElement>("[data-scroll-surface]")!;
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 34;
  });
}

function inset(block: Locator) {
  return block.evaluate((element) => {
    const viewport = element.closest<HTMLElement>("[data-scroll-surface]")!;
    return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
}

async function roundTrip(page: Page, block: Locator) {
  await alignBlock(block);
  const initial = await inset(block);
  await page.getByRole("button", { name: "编辑正文" }).click();
  const editorLine = page.getByRole("textbox", { name: "Markdown 正文" }).getByText("第 45 段");
  await expect(editorLine).toBeInViewport();
  await expect.poll(async () => Math.abs((await inset(editorLine)) - initial)).toBeLessThan(8);
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect.poll(async () => Math.abs((await inset(block)) - initial)).toBeLessThan(8);
}

test("preserves_reader_editor_reader_position", async ({ page }) => {
  await page.route("**/spike-delayed-image.png", (route) => route.abort());
  await page.goto("/?fixture=anchors");
  await roundTrip(page, page.getByText("第 45 段", { exact: true }));
});

test("duplicate_blocks_keep_distinct_ids", async ({ page }) => {
  await page.route("**/spike-delayed-image.png", (route) => route.abort());
  await page.goto("/?fixture=anchors");
  const headings = page.getByRole("heading", { name: "重复标题" });
  await expect(headings).toHaveCount(2);
  const ids = await headings.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-block-id")),
  );
  expect(ids[0]).toBeTruthy();
  expect(ids[0]).not.toBe(ids[1]);
});

test("image_reflow_keeps_anchor", async ({ page }) => {
  let allowImage = () => {};
  const waiting = new Promise<void>((resolve) => {
    allowImage = resolve;
  });
  let requestCount = 0;
  await page.route("**/spike-delayed-image.png", async (route) => {
    if (++requestCount > 1) await waiting;
    if (requestCount === 1) {
      await route.abort();
    } else {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="320"/>',
      });
    }
  });
  await page.goto("/?fixture=anchors");
  const block = page.getByText("第 45 段", { exact: true });
  await alignBlock(block);
  const initial = await inset(block);
  await page.getByRole("button", { name: "编辑正文" }).click();
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect.poll(() => requestCount).toBeGreaterThan(1);
  allowImage();
  await expect
    .poll(() =>
      page.getByRole("img").evaluate((element) => (element as HTMLImageElement).naturalHeight),
    )
    .toBe(320);
  await expect.poll(async () => Math.abs((await inset(block)) - initial)).toBeLessThan(8);
});

test("empty_document_switches_surfaces", async ({ page }) => {
  await page.goto("/?fixture=empty");
  await expect(page.getByRole("article")).toBeEmpty();
  await page.getByRole("button", { name: "编辑正文" }).click();
  await expect(page.getByRole("textbox")).toBeFocused();
  await page.getByRole("button", { name: "返回阅读" }).click();
  await expect(page.getByRole("article")).toBeEmpty();
});
