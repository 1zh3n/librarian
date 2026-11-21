import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
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
  await expect(form.getByRole("checkbox", { name: "本轮使用 budget.pdf" })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "本轮使用 meeting.docx" })).toBeChecked();
  const ids = new Set<string>();
  const req = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/turns"));
  await form.getByRole("textbox", { name: "提示词" }).fill("对比两个数字。");
  await form.getByRole("button", { name: "询问", exact: true }).click();
  for (const id of (await req).postDataJSON().materialIds as string[]) ids.add(id);
  expect(ids.size).toBe(2);
  await form.getByRole("button", { name: "移除 budget.pdf" }).click();
  await expect(form.getByRole("checkbox", { name: "本轮使用 budget.pdf" })).toHaveCount(0);
  const failed = page.waitForEvent("filechooser");
  await picker.click();
  await (
    await failed
  ).setFiles({ name: "损坏.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(form.getByText(/文件损坏/)).toBeVisible();
  await form.getByRole("button", { name: "移除 损坏.pdf" }).click();
  await expect(form.getByText("损坏.pdf", { exact: true })).toHaveCount(0);
});

test("finds_and_reads_segments_from_selected_files", async ({ browser }, testInfo) => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  await new Promise<void>((done) => reservation.close(() => done()));
  const baseURL = `http://127.0.0.1:${address.port}`;
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
  const child = spawn(
    resolve(target, "debug/examples/reader_fixture"),
    [String(address.port), "--managed-materials"],
    { stdio: "ignore" },
  );
  const exited = once(child, "exit");
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await expect
      .poll(async () => (await context.request.get("/api/v1/health").catch(() => null))?.status())
      .toBe(200);
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
      [390, 440, 100],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page
        .locator("html")
        .evaluate((el, percent) => (el.style.fontSize = `${percent}%`), font);
      const list = form.getByRole("list");
      expect(await list.evaluate(el=>el.scrollHeight <= el.clientHeight+1), "both file rows fit at this text size").toBe(true);
      await textarea.focus();
      await form.getByRole("button", { name: "询问", exact: true }).scrollIntoViewIfNeeded();
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
      expect(data.text).toBe(
        material.name.endsWith(".pdf") ? "预算为七十。" : "复核数字为四十二。",
      );
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
      await excerpt.getByRole("button", { name: "收起原文" }).click();
      await expect(citation).toBeFocused();
    }
    await form.getByRole("button", { name: "移除 budget.pdf" }).click();
    await expect(
      page.getByText("budget.pdf · 第 2 页（材料已失效）", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    if (child.exitCode === null) child.kill("SIGINT");
    await exited;
  }
});
