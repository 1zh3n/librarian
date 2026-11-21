import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { test } from "./managedMaterialsFixture";
import type { DocumentSnapshot } from "../../src/api/client";
import { createNote, openDocumentTool } from "./productFixture";

const samples = (name: string) =>
  fileURLToPath(
    new URL("../../../../bin/librarian/tests/fixtures/ai-materials/" + name, import.meta.url),
  );

test("selects_private_files_for_the_turn_and_recovers_from_parse_failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createNote(page, "材料核对.md", "# 预算复核\n\n请比较私有材料。");
  await openDocumentTool(page, "AI");
  const form = page.getByRole("form", { name: "AI 请求" });
  const picker = form.getByRole("button", { name: "选择文件" });
  await expect(picker).toBeVisible({ timeout: 2000 });
  const chosen = page.waitForEvent("filechooser");
  await picker.click();
  await (await chosen).setFiles([samples("budget.pdf"), samples("meeting.docx")]);
  await expect(form.getByText(/模型供应商/)).toBeVisible();
  const budget = form.getByRole("checkbox", { name: "本轮使用 budget.pdf", exact: true });
  await expect(budget).toBeChecked();
  await budget.focus();
  await page.keyboard.press("Space");
  await expect(budget).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(budget).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "本轮使用 meeting.docx" })).toBeChecked();
  const ids = new Set<string>();
  const queued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("textbox", { name: "提示词" }).fill("对比两个数字。");
  await form.getByRole("button", { name: "询问", exact: true }).click();
  const response = await queued;
  expect(response.status()).toBe(202);
  for (const id of response.request().postDataJSON().materialIds as string[]) ids.add(id);
  expect(ids.size).toBe(2);
  await form.getByRole("button", { name: "移除 budget.pdf" }).click();
  await expect(form.getByRole("checkbox", { name: "本轮使用 budget.pdf" })).toHaveCount(0);
  const failed = page.waitForEvent("filechooser");
  await picker.click();
  await (
    await failed
  ).setFiles({ name: "损坏.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(form.getByRole("alert").filter({ hasText: "文件损坏" })).toBeVisible();
  await form.getByRole("button", { name: "移除 损坏.pdf" }).click();
  await expect(form.getByText("损坏.pdf", { exact: true })).toHaveCount(0);
});

test("finds_and_reads_segments_from_selected_files", async ({ page }, testInfo) => {
  const context = page.context();
  await createNote(page, "预算与会议.md", "# 预算核对\n\n核对本次采购的数量。");
  await openDocumentTool(page, "AI");
  const form = page.getByRole("form", { name: "AI 请求" });
  const chooser = page.waitForEvent("filechooser");
  await form.getByRole("button", { name: "选择文件" }).click();
  await (await chooser).setFiles([samples("budget.pdf"), samples("meeting.docx")]);
  await expect(form.getByRole("checkbox", { name: "本轮使用 meeting.docx" })).toBeChecked();
  const textarea = form.getByRole("textbox", { name: "提示词" });
  await textarea.fill("预算和复核数字分别是多少？");
  for (const [width, height, font] of [
    [390, 844, 100],
    [360, 844, 100],
    [320, 844, 100],
    [390, 844, 200],
    [390, 844, 100],
    [390, 440, 100],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.locator("html").evaluate((el, percent) => (el.style.fontSize = `${percent}%`), font);
    const list = form.getByRole("list");
    expect(
      await list.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      "both file rows fit at this text size",
    ).toBe(true);
    if (font === 200) {
      await list.evaluate((el) => el.scrollIntoView({ block: "center" }));
      const name = "materials-filenames-200";
      const path = testInfo.outputPath(name + ".png");
      await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    if (height === 844) {
      await textarea.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await textarea.tap();
    }
    const submit = form.getByRole("button", { name: "询问", exact: true });
    for (const [name, control] of [
      ["prompt", textarea],
      ["submit", submit],
    ] as const) {
      await expect
        .poll(
          () =>
            control.evaluate((el) => {
              const bounds = el.getBoundingClientRect();
              const hit = document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              );
              if (el.contains(hit)) return "reachable";
              return `center ${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)} hit ${hit?.tagName ?? "outside viewport"}`;
            }),
          { message: `${name} hit target at ${width}×${height} (${font}%)`, timeout: 1500 },
        )
        .toBe("reachable");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(form.getByRole("button", { name: "询问", exact: true })).toBeInViewport();
    const imageName = `materials-${width}-${height}-${font}`;
    const path = testInfo.outputPath(imageName + ".png");
    await page.screenshot({ path });
    await testInfo.attach(imageName, { path, contentType: "image/png" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const queued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: "询问", exact: true }).click();
  expect((await queued).status()).toBe(202);
  const headers = {
    authorization: "Bearer synthetic-material-fixture-token",
    "x-librarian-runner-id": "material-fixture",
  };
  const claims = "/api/v1/ai/runner/v2/claims";
  const claim = await context.request.post(claims, { headers, data: {} });
  expect(claim.status()).toBe(200);
  const { leaseId, input } = (await claim.json()) as {
    leaseId: string;
    input: { materials: { id: string; name: string }[] };
  };
  expect(input.materials.length).toBe(2);
  const sourceIds: string[] = [];
  for (const material of input.materials) {
    const path = `${claims}/${leaseId}/materials/${material.id}/segments`;
    const directory = await context.request.get(path, {
      headers,
      params: { q: material.name.endsWith(".pdf") ? "预算" : "复核" },
    });
    expect(directory.status()).toBe(200);
    const { items } = (await directory.json()) as { items: { segmentId: string }[] };
    expect(items).toHaveLength(1);
    const read = await context.request.get(`${path}/${items[0]!.segmentId}`, { headers });
    expect(read.status()).toBe(200);
    const data = (await read.json()) as { text: string; source: { id: string } };
    expect(data.text).toBe(material.name.endsWith(".pdf") ? "预算为七十。" : "复核数字为四十二。");
    sourceIds.push(data.source.id);
  }
  const result = await context.request.put(`${claims}/${leaseId}/result`, {
    headers,
    data: { answer: "预算为七十，复核为四十二。", sourceIds, edits: [] },
  });
  expect(result.status()).toBe(200);
  for (const [label, text] of [
    ["budget.pdf · 第 2 页", "预算为七十。"],
    ["meeting.docx · 第 2 段", "复核数字为四十二。"],
  ] as const) {
    const citation = page.getByRole("button", { name: label, exact: true });
    await citation.click();
    const excerpt = page.getByRole("region", { name: label });
    await expect(excerpt.getByText(text, { exact: true })).toBeVisible();
    const image = testInfo.outputPath(
      label.startsWith("budget") ? "pdf-source.png" : "docx-source.png",
    );
    await excerpt.scrollIntoViewIfNeeded();
    await page.screenshot({ path: image });
    await testInfo.attach(label, { path: image, contentType: "image/png" });
    const close = excerpt.getByRole("button", { name: "收起原文" });
    if (label.startsWith("budget")) {
      await close.focus();
      await page.keyboard.press("Escape");
    } else {
      await close.click();
    }
    await expect(excerpt).toHaveCount(0);
    await expect(citation).toBeFocused();
  }
  await form.getByRole("button", { name: "移除 budget.pdf" }).click();
  await expect(page.getByText("budget.pdf · 第 2 页（材料已失效）", { exact: true })).toBeVisible();
  await page.reload();
  if (!(await form.isVisible())) await openDocumentTool(page, "AI");
  await expect(page.getByText("预算为七十，复核为四十二。", { exact: true })).toBeVisible();
  const existing = form.getByRole("checkbox", { name: "本轮使用 meeting.docx" });
  await expect(existing).not.toBeChecked();
  await form.locator("label").filter({ hasText: "本轮使用 meeting.docx" }).tap();
  await expect(existing).toBeChecked();
  await textarea.fill("只核对会议纪要。");
  const followup = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: "询问", exact: true }).click();
  expect((await followup).status()).toBe(202);
  const next = await context.request.post(claims, { headers, data: {} });
  expect(next.status()).toBe(200);
  const nextInput = (await next.json()).input;
  expect(nextInput.materials).toEqual(input.materials.filter((m) => m.name === "meeting.docx"));
  expect(nextInput.history).toEqual([]);
});

test("citation Back restores only the draft materials still available in its conversation", async ({
  page,
}) => {
  const { document, origin } = await createNote(page, "材料草稿.md", "# 材料草稿");
  const created = await page.request.post(
    `/api/v1/workspaces/${document.document.workspaceId}/documents`,
    {
      headers: { origin },
      data: { path: "核对来源.md", markdown: "# 核对来源\n\n采购已复核。", baseRevision: null },
    },
  );
  expect(created.status()).toBe(201);
  const source = (await created.json()) as DocumentSnapshot;
  await openDocumentTool(page, "AI");
  const form = page.getByRole("form", { name: "AI 请求" });
  const chooser = page.waitForEvent("filechooser");
  await form.getByRole("button", { name: "选择文件" }).click();
  await (await chooser).setFiles([samples("notes.txt"), samples("agenda.md")]);
  const notes = form.getByRole("checkbox", { name: "本轮使用 notes.txt" });
  const agenda = form.getByRole("checkbox", { name: "本轮使用 agenda.md" });
  await expect(notes).toBeChecked();
  await expect(agenda).toBeChecked();
  const prompt = form.getByRole("textbox", { name: "提示词" });
  const send = form.getByRole("button", { name: "询问", exact: true });
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await prompt.fill("核对采购记录。");
  await send.click();
  const turn = await accepted;
  expect(turn.status()).toBe(202);
  const materials = turn.url().replace(/\/turns$/u, "/materials");
  const headers = {
    authorization: "Bearer synthetic-material-fixture-token",
    "x-librarian-runner-id": "material-fixture",
  };
  const claims = "/api/v1/ai/runner/v2/claims";
  const claim = await page.request.post(claims, { headers });
  expect(claim.status()).toBe(200);
  const { leaseId, input } = (await claim.json()) as {
    leaseId: string;
    input: { materials: { id: string; name: string }[] };
  };
  const read = await page.request.post(`${claims}/${leaseId}/sources`, {
    headers,
    data: { documentId: source.document.id, full: true },
  });
  expect(read.status()).toBe(200);
  const result = await page.request.put(`${claims}/${leaseId}/result`, {
    headers,
    data: { answer: "采购已复核。", sourceIds: [(await read.json()).source.id], edits: [] },
  });
  expect(result.status()).toBe(200);
  const citation = page.getByRole("link", { name: "核对来源.md", exact: true });
  await expect(citation).toBeVisible();
  await prompt.fill("继续用剩余材料核对。");
  await citation.click();
  await expect(page).toHaveURL(new RegExp(source.document.id));
  const removed = input.materials.find((m) => m.name === "agenda.md")!;
  expect(
    (await page.request.delete(`${materials}/${removed.id}`, { headers: { origin } })).status(),
  ).toBe(204);
  await page.goBack();
  await expect(prompt).toHaveValue("继续用剩余材料核对。");
  await expect(notes).toBeChecked();
  await expect(agenda).toHaveCount(0);
  const followup = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url() === turn.url(),
  );
  await send.click();
  const receipt = await followup;
  expect(receipt.status()).toBe(202);
  expect(receipt.request().postDataJSON().materialIds).toEqual(
    input.materials.filter((m) => m.name === "notes.txt").map((m) => m.id),
  );
});
