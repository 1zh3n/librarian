import { writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { test } from "./managedMaterialsFixture";
import { createNote, signIn } from "./productFixture";

const first = {
  question:
    "请比较河岸调查记录中清晨和午后的水位、雨量及鸟群观察，并说明哪些差异值得在下一轮调查中复核？",
  answer:
    "清晨，潮水还没有漫过下游的沙洲，观察员在芦苇外缘记录到成群觅食的白鹭。午后水位上涨，裸露的浅滩逐渐消失，记录中的活动区域也移到了上游。\n\n两次调查使用同一个观测点。午后经过栈道的访客更多，记录者特别标注了两次受惊起飞。因此，两组计数适合描述当天的空间分布，暂时还不能用来判断季节变化。\n\n| 地区 | 雨量合计 | 来源 |\n| --- | --- | --- |\n| 东区 | 713 毫米 | 河岸调查 / ws_80123d98d6ef42ac8b670a205f2ebe5d / `doc_777ea575a12648a6a5153e10f155b7c5` |\n| 西区 | 906 毫米 | 西岸观测 / ws_332c1b7126214d028810849eff2f128e |\n\n原始记录路径：\n\n```text\nfield-notes/2026-11/observations/downstream-gauge-20261120T073000+0800.csv\n```",
};
const second = {
  question: "请整理成下一次外业可以直接使用的观察清单。",
  answer:
    "下次调查可以沿用今天的观测点，分别在清晨低潮和午后涨潮时记录。每次在固定位置停留十五分钟，先标记水线，再记录不同区域的鸟群。\n\n- 记录开始和结束时间，同时标记潮位与能见度。\n- 分开统计芦苇边缘、浅滩和上游河道中的个体。\n- 将飞过和落地的个体分列，避免重复计数。\n\n已经将这份清单保存到工作区，供出发前核对。",
};
async function complete(
  page: Page,
  { question, answer }: typeof first,
  sourceNote: { id: string; workspaceId: string },
  global: boolean,
  edit = false,
) {
  const form = page.getByRole("form", { name: "AI 请求" });
  await form.getByRole("textbox", { name: "提示词" }).fill(question);
  if (edit) {
    await form.getByRole("button", { name: /发送模式/ }).click();
    await page.getByRole("option", { name: global ? "修改与管理" : "修改", exact: true }).click();
  }
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: "发送", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  const headers = {
    authorization: "Bearer synthetic-material-fixture-token",
    "x-librarian-runner-id": "material-fixture",
  };
  const claims = "/api/v1/ai/runner/v2/claims";
  const claimed = await page.request.post(claims, { headers });
  expect(claimed.status()).toBe(200);
  const { leaseId, input } = await claimed.json();
  expect(input.mode).toBe(edit ? "edit" : "chat");
  const source = await page.request.post(claims + "/" + leaseId + "/sources", {
    headers,
    data: {
      documentId: sourceNote.id,
      ...(global && { workspaceId: sourceNote.workspaceId }),
      full: true,
    },
  });
  expect(source.status()).toBe(200);
  const saved = await page.request.put(claims + "/" + leaseId + "/result", {
    headers,
    data: {
      answer,
      sourceIds: [(await source.json()).source.id],
      ...(global && edit && { targetWorkspaceId: sourceNote.workspaceId }),
      edits: edit ? [{ path: "下一次外业清单.md", baseRevision: null, markdown: answer }] : [],
    },
  });
  expect(saved.status()).toBe(200);
  await expect(page.getByText(answer.split("\n")[0]!, { exact: true })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name + ".png");
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
async function lineCount(text: Locator) {
  return text.evaluate((el) => {
    const range = new Range();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
  });
}
async function centerHits(control: Locator) {
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
}
for (const scope of ["global", "workspace"] as const) {
  test(`${scope} conversation uses the remaining height and keeps source, receipt and composer reachable`, async ({
    page,
    browser,
  }, info) => {
    const global = scope === "global";
    const { document } = await createNote(
      page,
      "河岸调查记录.md",
      "# 河岸调查\n\n清晨低潮，白鹭在沙洲觅食。午后水位上涨，鸟群沿上游分散。",
    );
    await page.goto(global ? "/ai" : "/workspaces/" + document.document.workspaceId + "/ai");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await complete(page, first, document.document, global);
    await complete(page, second, document.document, global, true);
    const transcript = page.getByRole("region", { name: "对话记录" });
    const group = transcript.getByRole("article").last();
    await expect(group.getByRole("list", { name: "引用来源" })).toBeVisible();
    await expect(group.getByRole("region", { name: "操作回执" })).toContainText(
      "下一次外业清单.md",
    );
    const history = page.getByRole("button", { name: /切换会话/ });
    const more = page.getByRole("button", { name: "会话操作", exact: true });
    const newChat = page.getByRole("button", { name: "新对话", exact: true });
    const input = page.getByRole("textbox", { name: "提示词" });
    const send = page.getByRole("button", { name: "发送", exact: true });
    const measurements = [];
    await input.fill("下雨时需要补记哪些项目？");
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(history).toContainText(first.question);
      if (global) {
        const label = page
          .getByRole("button", { name: /对话范围/ })
          .getByText("全部空间", { exact: true });
        expect(await lineCount(label), "scope stays on a single line").toBe(1);
      }
      const centerDifferences = [];
      for (const row of [
        [
          ...(global ? [page.getByRole("button", { name: /对话范围/ })] : []),
          history,
          newChat,
          more,
        ],
        [
          page.getByRole("button", { name: "选择文件" }),
          page.getByRole("button", { name: /发送模式/ }),
          send,
        ],
      ]) {
        const centers = await Promise.all(
          row.map((el) =>
            el.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              return rect.top + rect.height / 2;
            }),
          ),
        );
        const difference = Math.max(...centers) - Math.min(...centers);
        expect(difference).toBeLessThanOrEqual(2);
        centerDifferences.push(difference);
      }
      const bounds = await transcript.boundingBox();
      expect(bounds!.height).toBeGreaterThan(height * 0.54);
      await expect.poll(() => centerHits(send)).toBe(true);
      const form = await page.getByRole("form", { name: "AI 请求" }).boundingBox();
      const bottomGap = height - form!.y - form!.height;
      expect(bottomGap).toBeLessThan(48);
      measurements.push({
        width,
        height,
        transcriptHeight: bounds!.height,
        bottomGap,
        toolbarCenterDifference: centerDifferences[0],
        composerCenterDifference: centerDifferences[1],
      });
      await transcript
        .getByRole("article")
        .first()
        .getByText(first.answer.split("\n\n")[1]!, { exact: true })
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await capture(page, info, "two-turns-" + width);
      if (width === 390) {
        const code = transcript.locator("pre");
        expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        expect(await transcript.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const table = transcript.getByRole("table");
        for (const name of ["地区", "雨量合计"]) {
          const heading = table.getByRole("columnheader", { name });
          expect(await lineCount(heading)).toBe(1);
        }
        const scroller = transcript.getByRole("region", { name: "回答表格" });
        await scroller.focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(scroller).toBeFocused();
        await expect(scroller).toHaveCSS("outline-style", "solid");
        await scroller.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await capture(page, info, "table-390");
        expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        await input.focus();
      }
      await group
        .getByRole("region", { name: "操作回执" })
        .evaluate((el) => el.scrollIntoView({ block: "end" }));
      await capture(page, info, "receipt-" + width);
    }
    const measurementPath = info.outputPath("measurements.json");
    await writeFile(measurementPath, JSON.stringify(measurements, null, 2) + "\n");
    await info.attach("layout measurements", {
      path: measurementPath,
      contentType: "application/json",
    });
    for (const [width, percent] of [
      [320, 100],
      [320, 200],
      [390, 200],
      [390, 100],
    ] as const) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator("html").evaluate((el, size) => (el.style.fontSize = size + "%"), percent);
      await expect.poll(() => centerHits(send)).toBe(true);
      const formBounds = await page.getByRole("form", { name: "AI 请求" }).boundingBox();
      for (const control of [
        input,
        page.getByRole("button", { name: "选择文件" }),
        page.getByRole("button", { name: /发送模式/ }),
        send,
      ]) {
        const box = await control.boundingBox();
        expect(
          box!.y + box!.height,
          `${width}px at ${percent}%: composer clips ${await control.textContent()}`,
        ).toBeLessThanOrEqual(formBounds!.y + formBounds!.height);
      }
      if (global) {
        const scopeButton = page.getByRole("button", { name: /对话范围/ });
        expect(await lineCount(scopeButton.getByText("全部空间", { exact: true }))).toBe(1);
        for (const control of [scopeButton, history, newChat, more]) {
          expect(
            await centerHits(control),
            `${width}px, ${percent}%, ${await control.getAttribute("aria-label")} ${JSON.stringify(await control.boundingBox())}`,
          ).toBe(true);
        }
      }
      expect(
        await page.evaluate(() => window.document.documentElement.scrollWidth),
        `${width}px at ${percent}% text`,
      ).toBeLessThanOrEqual(width);
      if (percent === 200) await capture(page, info, "large-text-" + width);
    }
    await input.focus();
    await page.setViewportSize({ width: 390, height: 440 });
    for (const el of [input, send]) await expect.poll(() => centerHits(el)).toBe(true);
    await expect(input).toBeFocused();
    await capture(page, info, "keyboard-390");
    await page.setViewportSize({ width: 390, height: 844 });
    await more.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "删除会话" }).click();
    const confirm = page.getByRole("dialog", { name: "删除会话" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await expect(input).toHaveValue("下雨时需要补记哪些项目？");
    const written = group
      .getByRole("region", { name: "操作回执" })
      .getByRole("link", { name: "下一次外业清单.md" });
    await written.click();
    await expect(page.getByRole("article", { name: "下一次外业清单", exact: true })).toContainText(
      "下次调查可以沿用今天的观测点",
    );
    await page.goBack();
    await expect(written).toBeFocused();
    await expect(input).toHaveValue("下雨时需要补记哪些项目？");
    await expect(page.getByRole("button", { name: /发送模式/ })).toContainText("修改");
    await history.click();
    await expect(page.getByRole("menuitemradio", { name: first.question })).toBeVisible();
    await page.keyboard.press("Escape");
    if (global) {
      const origin = new URL(page.url()).origin;
      const admin = await browser.newContext({ baseURL: origin });
      try {
        await signIn(await admin.newPage(), "fixture-admin", "fixture-admin-test-password");
        const downgraded = await admin.request.put(
          `/api/v1/workspaces/${document.document.workspaceId}/members/reader`,
          {
            headers: { origin },
            data: { role: "read" },
          },
        );
        expect(downgraded.status()).toBe(200);
        await page.reload();
        await expect(written).toBeVisible();
        await expect(group.getByRole("button", { name: "撤销", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /发送模式/ })).toBeEnabled();
      } finally {
        await admin.close();
      }
    }
  });
}

test("Back from a read-only space restores the assistant's unsent question and write mode", async ({
  page,
}) => {
  await signIn(page, "offline-reader", "offline-reader-test-password");
  await page.goto("/ai");
  const input = page.getByRole("textbox", { name: "提示词" });
  await input.fill("请创建一个春季观察空间。");
  await page.getByRole("button", { name: /发送模式/ }).click();
  await page.getByRole("option", { name: /管理/ }).click();
  await page.getByRole("button", { name: /对话范围/ }).click();
  await page.getByRole("option", { name: "另一空间", exact: true }).click();
  await expect(page.getByRole("heading", { name: "另一空间 · 工作区 AI" })).toBeVisible();
  await expect(input).toBeEmpty();
  await expect(page.getByRole("button", { name: /发送模式/ })).toHaveCount(0);
  await page.goBack();
  await expect(input).toHaveValue("请创建一个春季观察空间。");
  await expect(page.getByRole("button", { name: /发送模式/ })).toContainText("修改与管理");
  await expect(input).toBeFocused();
});

test("a denied event replay removes the streamed answer, question, and stale topic", async ({
  page,
}) => {
  const { document: note } = await createNote(page, "田野资料.md", "调查样本。");
  await page.goto("/workspaces/" + note.document.workspaceId + "/ai");
  const form = page.getByRole("form", { name: "AI 请求" });
  const question = "核对本次未公布的调查数字";
  await form.getByRole("textbox", { name: "提示词" }).fill(question);
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/turns"),
  );
  await form.getByRole("button", { name: "发送", exact: true }).click();
  expect((await accepted).status()).toBe(202);
  const headers = {
    authorization: "Bearer synthetic-material-fixture-token",
    "x-librarian-runner-id": "material-fixture",
  };
  const claims = "/api/v1/ai/runner/v2/claims";
  const claim = await page.request.post(claims, { headers });
  expect(claim.status()).toBe(200);
  const { leaseId } = await claim.json();
  const partial = "本次调查的原始计数为二十六只。";
  const event = await page.request.post(claims + "/" + leaseId + "/events", {
    headers,
    data: { kind: "text_delta", executorSeq: 1, text: partial },
  });
  expect(event.status()).toBe(200);
  await expect(page.getByText(partial, { exact: true })).toBeVisible();
  const rechecked = page.waitForRequest((r) => r.method() === "GET" && r.url().includes("/turns"));
  await page.route("**/ai/operations/*/events", (route) =>
    route.fulfill({ status: 403, json: { code: "forbidden", message: "Access changed" } }),
  );
  await expect(page.getByText(partial, { exact: true })).toHaveCount(0);
  await rechecked;
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
});

test("composer text entry and attachment have distinct keyboard focus targets", async ({
  page,
}) => {
  const { document: note } = await createNote(page, "焦点.md", "输入区域焦点。");
  await page.goto("/workspaces/" + note.document.workspaceId + "/ai");
  const form = page.getByRole("form", { name: "AI 请求" });
  const prompt = form.getByRole("textbox", { name: "提示词" });
  const file = form.getByRole("button", { name: "选择文件" });
  await prompt.fill("核对材料");
  await expect(form).toHaveCSS("outline-style", "solid");
  await expect(prompt).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Tab");
  await expect(file).toBeFocused();
  await expect(file).toHaveCSS("outline-style", "solid");
  await expect(form).toHaveCSS("outline-style", "none");
  await expect(file.locator('[data-icon="paperclip"]')).toBeVisible();
});
