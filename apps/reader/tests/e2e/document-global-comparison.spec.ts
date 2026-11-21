import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  acrossSpaces,
  followUpAcrossSpaces,
  startManagedReader,
} from "../../../../bin/librarian/tests/fixtures/managed-reader.mjs";
import type {
  ManagedReader,
  ScriptedTurn,
} from "../../../../bin/librarian/tests/fixtures/managed-reader.mjs";
import { openFieldWorkspace } from "./productFixture";

async function send(page: Page, reader: ManagedReader, turn: ScriptedTurn) {
  await page.getByRole("textbox", { name: "提示词" }).fill(turn.prompt);
  const sendButton = page.getByRole("button", { name: "发送", exact: true });
  await expect(sendButton).toBeEnabled();
  const queued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await sendButton.click();
  expect((await queued).status()).toBe(202);
  const answer = page.getByText(turn.answer, { exact: true });
  await expect
    .poll(async () => reader.failure() ?? (await answer.isVisible()), { timeout: 20_000 })
    .toBe(true);
  reader.finish(turn);
  await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
}

test("one assistant compares same-named documents across spaces and resumes after a citation", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const reader = await startManagedReader();
  const context = await browser.newContext({ baseURL: reader.url });
  try {
    const page = await context.newPage();
    const firstSpace = await openFieldWorkspace(page);
    const headers = { origin: reader.url };
    const create = await page.request.post("/api/v1/workspaces", {
      headers,
      data: { name: "河口调查" },
    });
    expect(create.status()).toBe(201);
    const secondSpace = (await create.json()) as { id: string };
    for (const [space, text] of [
      [firstSpace.id, "记录十只。"],
      [secondSpace.id, "记录二十只。"],
    ] as const) {
      const note = await page.request.post(`/api/v1/workspaces/${space}/documents`, {
        headers,
        data: { path: "普查记录.md", markdown: "# 普查记录\n\n" + text, baseRevision: null },
      });
      expect(note.status()).toBe(201);
    }
    await page.getByRole("banner").getByRole("button", { name: "AI", exact: true }).click();
    await send(page, reader, acrossSpaces);
    const sources = page.getByRole("list", { name: "引用来源" }).first();
    const firstLink = sources.getByRole("link", { name: /田野笔记.*普查记录/ });
    const secondLink = sources.getByRole("link", { name: /河口调查.*普查记录/ });
    await expect(firstLink).toHaveAttribute(
      "href",
      new RegExp("/workspaces/" + firstSpace.id + "/documents/.+#reader-source\\?revision="),
    );
    await expect(secondLink).toHaveAttribute(
      "href",
      new RegExp("/workspaces/" + secondSpace.id + "/documents/.+#reader-source\\?revision="),
    );
    await page.getByRole("textbox", { name: "提示词" }).fill(followUpAcrossSpaces.prompt);
    await secondLink.click();
    await expect(page.getByText("记录二十只。", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(secondLink).toBeFocused();
    await expect(page.getByRole("textbox", { name: "提示词" })).toHaveValue(
      followUpAcrossSpaces.prompt,
    );
    await send(page, reader, followUpAcrossSpaces);
    await page.reload();
    await expect(page.getByText(followUpAcrossSpaces.answer, { exact: true })).toBeVisible();
    reader.verify([acrossSpaces, followUpAcrossSpaces]);
  } finally {
    await Promise.all([context.close(), reader.close()]);
  }
});
