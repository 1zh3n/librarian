import { expect, test as base } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { openFieldWorkspace } from "./productFixture";
import {
  comparison,
  first,
  materialTurn,
  privateMarkers,
  startManagedReader,
} from "../../../../bin/librarian/tests/fixtures/managed-reader.mjs";
import type {
  ManagedReader,
  ScriptedTurn,
} from "../../../../bin/librarian/tests/fixtures/managed-reader.mjs";

const test = base.extend<{ fixture: ManagedReader }>({
  fixture: [
    async ({ browser }, use, info) => {
      info.annotations.push({ type: "browser", description: browser.version() });
      const reader = await startManagedReader();
      try {
        await use(reader);
      } finally {
        await reader.close();
      }
    },
    { timeout: 240_000 },
  ],
  baseURL: async ({ fixture }, use) => use(fixture.url),
});

test.describe.configure({ timeout: 80_000 });
test.use({ hasTouch: true });

const form = (page: Page) => page.getByRole("form", { name: "AI 请求" });

async function send(page: Page, fixture: ManagedReader, turn: ScriptedTurn, info?: TestInfo) {
  const prompt = form(page).getByRole("textbox", { name: "提示词" });
  await prompt.fill(turn.prompt);
  const queued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form(page).getByRole("button", { name: "发送", exact: true }).click();
  expect((await queued).status()).toBe(202);
  // The upstream holds message_stop until Chromium observes the visible delta.
  const preview = page.getByText(turn.answer, { exact: true });
  await expect
    .poll(async () => fixture.failure() || ((await preview.isVisible()) ? "streamed" : "waiting"), {
      timeout: 20_000,
    })
    .toBe("streamed");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  for (const marker of privateMarkers) await expect(page.locator("body")).not.toContainText(marker);
  if (info) await screenshot(page, info, "comparison-stream");
  fixture.finish(turn);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(preview).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

async function useComparisonModel(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "应用设置" });
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  const mine = dialog.getByRole("region", { name: "我的模型" });
  await mine.getByRole("button", { name: /模型连接/ }).click();
  await page.getByRole("option", { name: "田野模型" }).click();
  await mine.getByRole("button", { name: / 模型$/ }).click();
  await page.getByRole("option", { name: comparison.model, exact: true }).click();
  await mine.getByRole("button", { name: /思考等级/ }).click();
  await page.getByRole("option", { name: comparison.level, exact: true }).click();
  await mine.getByRole("button", { name: "保存偏好" }).click();
  await expect(dialog.getByText("模型偏好已保存。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("banner").getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
}

test("refresh_then_compare_documents_with_tools_in_both_turns", async ({ fixture, page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const payloads: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().startsWith(fixture.url + "/api/v1/") && response.ok())
      payloads.push(response.text().catch(() => ""));
  });
  const workspace = await openFieldWorkspace(page);
  await page.goto(`/workspaces/${workspace.id}/ai`);
  await send(page, fixture, first);
  const firstCitation = page
    .getByRole("list", { name: "引用来源" })
    .first()
    .getByRole("link", { name: "甲样区.md", exact: true });
  await expect(firstCitation).toBeVisible();
  await page.reload();
  await expect(page.getByText(first.answer, { exact: true })).toBeVisible();
  await firstCitation.click();
  await expect(page.getByText("甲样区记录十二只白鹭。", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(firstCitation).toBeVisible();
  await useComparisonModel(page);
  await send(page, fixture, comparison, info);
  const citations = page.getByRole("list", { name: "引用来源" }).last();
  await expect(citations.getByRole("link")).toHaveCount(2);
  await expect(citations.getByRole("link", { name: "甲样区.md" })).toBeVisible();
  const secondCitation = citations.getByRole("link", { name: "乙样区.md" });
  await expect(secondCitation).toBeVisible();
  for (const turn of [first, comparison])
    await expect(page.getByText(turn.model + " · " + turn.level, { exact: true })).toBeVisible();
  await screenshot(page, info, "comparison-desktop");
  await secondCitation.click();
  await expect(page.getByText("乙样区记录十九只白鹭。", { exact: true })).toBeVisible();
  await page.goBack();

  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [width, text] of [
    [320, 100],
    [390, 200],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("html").evaluate((el, size) => (el.style.fontSize = size + "%"), text);
    const latestAnswer = page.getByText(comparison.answer, { exact: true });
    await latestAnswer.scrollIntoViewIfNeeded();
    await expect(latestAnswer).toBeInViewport();
    const input = form(page).getByRole("textbox", { name: "提示词" });
    await input.fill("继续核对");
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    const ask = form(page).getByRole("button", { name: "发送", exact: true });
    await ask.scrollIntoViewIfNeeded();
    await expect(ask).toBeEnabled();
    await expect(ask).toBeInViewport();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    await screenshot(page, info, `comparison-${width}-text${text}-reduced`);
  }
  const payload = (await Promise.all(payloads)).join("\n");
  expect(payload).toContain("event: text_delta");
  for (const marker of privateMarkers) {
    expect(payload).not.toContain(marker);
    await expect(page.locator("body")).not.toContainText(marker);
  }
  fixture.verify([first, comparison]);
});

test("selected PDF and DOCX are read by the managed runner and open at their cited locations", async ({
  fixture,
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workspace = await openFieldWorkspace(page);
  await page.goto(`/workspaces/${workspace.id}/ai`);
  const chooser = page.waitForEvent("filechooser");
  await form(page).getByRole("button", { name: "选择文件" }).click();
  await (
    await chooser
  ).setFiles(
    ["budget.pdf", "meeting.docx"].map((name) =>
      fileURLToPath(
        new URL("../../../../bin/librarian/tests/fixtures/ai-materials/" + name, import.meta.url),
      ),
    ),
  );
  for (const file of ["budget.pdf", "meeting.docx"])
    await expect(form(page).getByRole("checkbox", { name: "本轮使用 " + file })).toBeChecked();
  await send(page, fixture, materialTurn);
  for (const [label, quote] of [
    ["budget.pdf · 第 2 页", "预算为七十。"],
    ["meeting.docx · 第 2 段", "复核数字为四十二。"],
  ] as const) {
    const link = page.getByRole("button", { name: label, exact: true });
    await link.click();
    const region = page.getByRole("region", { name: label });
    await expect(region.getByText(quote, { exact: true })).toBeVisible();
    await screenshot(page, info, label.startsWith("budget") ? "pdf-page-2" : "docx-paragraph-2");
    await region.getByRole("button", { name: "收起原文" }).click();
    await expect(link).toBeFocused();
  }
  fixture.verify([materialTurn]);
});
