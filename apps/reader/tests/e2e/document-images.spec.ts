import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createNote } from "./productFixture";

const png = readFileSync(new URL("../../../../server/testdata/images/tiny.png", import.meta.url));

function editor(page: Parameters<typeof createNote>[0]) {
  return page.locator('[contenteditable="true"][aria-label="Markdown 正文"]');
}

async function enterEditor(page: Parameters<typeof createNote>[0], text: string) {
  await page
    .getByRole("article")
    .getByText(text)
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page);
  await expect(body).toBeVisible();
  return body;
}

test("inserts, previews and reads an uploaded image", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ImageInsert.md", "# 图片插入\n\n正文起点。\n");
  const body = await enterEditor(page, "正文起点。");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "插入图片…" }).click();
  const dialog = page.getByRole("dialog", { name: "插入图片" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "选择文件" }).click();
  await (await chooser).setFiles({ name: "tiny.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "插入" }).click();
  await expect(dialog).toBeHidden();

  const preview = body.locator("[data-preview-image] img");
  await expect(preview).toBeVisible();
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(2);
  await expect(body).not.toContainText("![tiny]");
  await preview.click();
  await expect(body).toContainText("![tiny](assets/tiny.png)");
  await expect
    .poll(async () => (await (await page.request.get(apiUrl)).json()).markdown)
    .toContain("![tiny](assets/tiny.png)");

  await body.press("Escape");
  const reading = page.getByRole("article").getByRole("img", { name: "tiny" });
  await expect(reading).toBeVisible();
  await expect
    .poll(() => reading.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(2);
  await page.getByRole("button", { name: "文档更多" }).click();
  await expect(page.getByRole("menuitem", { name: "插入图片…" })).toBeVisible();
});

test("uses the server's renamed path for a second image", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ImageRename.md", "# 重名插入\n\n起点。\n");
  await enterEditor(page, "起点。");
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole("button", { name: "文档更多" }).click();
    await page.getByRole("menuitem", { name: "插入图片…" }).click();
    const dialog = page.getByRole("dialog", { name: "插入图片" });
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "选择文件" }).click();
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await dialog.getByRole("button", { name: "插入" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect
    .poll(async () => (await (await page.request.get(apiUrl)).json()).markdown)
    .toContain("assets/photo-2.png");
});

test("pastes an image file into the editor", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ImagePaste.md", "# 粘贴图片\n\n起点。\n");
  const body = await enterEditor(page, "起点。");
  const base64 = png.toString("base64");
  await body.evaluate((element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, base64);
  const preview = body.locator("[data-preview-image] img");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(apiUrl)).json()).markdown)
    .toContain("assets/pasted.png");
});

test("drops an image file at the editor pointer", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ImageDrop.md", "# 拖入图片\n\n起点。\n");
  const body = await enterEditor(page, "起点。");
  await body.press("Control+End");
  const box = await body.boundingBox();
  if (!box) throw new Error("Missing editor box");
  const base64 = png.toString("base64");
  await body.evaluate(
    (element, { encoded, x, y }) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      element.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { encoded: base64, x: box.x + 8, y: box.y + box.height / 2 },
  );
  const preview = body.locator("[data-preview-image] img");
  await expect(preview).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(apiUrl)).json()).markdown)
    .toContain("assets/dropped.png");
});

test("opens image insertion from reading mode and enters editing", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ImageReadingEntry.md", "# 阅读入口\n\n起点。\n");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "插入图片…" }).click();
  const dialog = page.getByRole("dialog", { name: "插入图片" });
  await expect(dialog).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "选择文件" }).click();
  await (await chooser).setFiles({ name: "reading.png", mimeType: "image/png", buffer: png });
  await dialog.getByRole("button", { name: "插入" }).click();
  await expect(dialog).toBeHidden();
  await expect(editor(page)).toBeVisible();
  await expect
    .poll(async () => (await (await page.request.get(apiUrl)).json()).markdown)
    .toContain("assets/reading.png");
});
