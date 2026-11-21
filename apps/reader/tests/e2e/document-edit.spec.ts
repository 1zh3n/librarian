import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { DocumentSnapshot, OutlineSnapshot } from "../../src/api/client";
import { closeDocumentTool, createNote, openDocumentTool } from "./productFixture";

function editor(page: Page, name: string) {
  return page.locator(`[contenteditable="true"][aria-label="${name}"]`);
}

async function readNote(page: Page, path: string) {
  return (await (await page.request.get(path)).json()) as DocumentSnapshot;
}

test("edits in place without a canvas outline and resumes reading when focus leaves", async ({
  page,
}) => {
  const { apiUrl } = await createNote(
    page,
    "InlineEditor.md",
    "---\ntitle: 就地编辑\n---\n\n在这里继续写。\n",
  );
  const article = page.getByRole("article");
  await article.getByText("在这里继续写。").click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await expect(body).toBeFocused();
  await expect(page.locator(".cm-editor.cm-focused")).toHaveCSS("outline-style", "none");
  await expect(body.locator(".cm-line").filter({ hasText: "在这里继续写。" })).toHaveCSS(
    "box-shadow",
    "none",
  );
  await expect(body.getByRole("button", { name: "Front Matter" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "返回阅读" })).toHaveCount(0);
  await body.press("End");
  await page.keyboard.insertText("继续写下去。");
  await page.getByRole("button", { name: "文档更多" }).focus();
  await expect(article).toContainText("继续写下去。");
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toContain("继续写下去。");
  await page.keyboard.press("Alt+e");
  await expect(body).toBeFocused();
  await body.press("Control+z");
  await expect(body).not.toContainText("继续写下去。");
  await body.press("Escape");
  await expect(article).toBeFocused();
});

test("places the editor caret at the clicked text within a paragraph", async ({ page }) => {
  const { apiUrl } = await createNote(page, "ClickCaret.md", "甲乙丙丁\n");
  const paragraph = page.getByRole("article").getByText("甲乙丙丁");
  const point = await paragraph.evaluate((element) => {
    const text = element.firstChild;
    if (!text) throw new Error("Missing paragraph text");
    const range = document.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const bounds = range.getBoundingClientRect();
    return { x: bounds.x + 0.5, y: bounds.y + bounds.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await expect(editor(page, "Markdown 正文")).toBeFocused();
  await page.keyboard.insertText("中");
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe("甲乙中丙丁\n");
});

for (const [name, original, firstEnding] of [
  ["text", "上文。\r\n正文。", "\r\n"],
  ["existing lines", "\uFEFF---\r\ntitle: 留白\r\n---\r\n\r\n短文。  \r\n\r\n", ""],
  ["empty", "", ""],
  ["metadata", "---\ntitle: 只有属性\n---\n", ""],
  ["indented", "正文。\n  ", ""],
] as const) {
  test(`blank paper reuses the final writing line until it contains text (${name})`, async ({
    page,
  }) => {
    const { apiUrl } = await createNote(page, `Paper-${name}.md`, original);
    const article = page.getByRole("article");
    const point = await article.evaluate((element) => {
      const column = element.getBoundingClientRect();
      const viewport = element.closest("main")!.getBoundingClientRect();
      return {
        x: column.left + column.width / 2,
        edge: viewport.left + 4,
        y: viewport.bottom - 24,
      };
    });
    const body = editor(page, "Markdown 正文");
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const ready = original + firstEnding;
    const saved = () => expect.poll(async () => (await readNote(page, apiUrl)).markdown);
    await page.mouse.click(point.x, point.y);
    await expect(body).toBeFocused();
    await body.press("Control+Home");
    await page.mouse.click(point.edge, point.y);
    await body.press("Escape");
    await expect(article).toBeVisible();
    await page.mouse.click(point.x, point.y);
    await expect(body).toBeFocused();
    await page.keyboard.insertText("初");
    await saved().toBe(ready + "初");

    await body.press("Control+Home");
    await page.mouse.click(point.edge, point.y);
    await saved().toBe(ready + "初" + newline);
    await page.mouse.click(point.edge, point.y);
    await page.keyboard.insertText("续");
    await saved().toBe(ready + "初" + newline + "续");
    for (const prior of [ready + "初" + newline, ready + "初", ready]) {
      await body.press("Control+z");
      await saved().toBe(prior);
    }
    if (firstEnding) {
      await body.press("Control+z");
      await saved().toBe(original);
      await body.press("Control+Shift+z");
      await saved().toBe(ready);
    }
  });
}

for (const prefix of ["", "---\ntitle: 未填写\n---"]) {
  test(`the writing line is visible on blank paper with long trailing whitespace (metadata=${!!prefix})`, async ({
    page,
  }) => {
    const source = prefix + "\r\n".repeat(120) + "    ";
    const { apiUrl } = await createNote(page, prefix ? "待填写属性.md" : "待填写.md", source);
    const point = await page.getByRole("article").evaluate((article) => {
      const main = article.closest("main")!;
      main.scrollTop = main.scrollHeight;
      return {
        x: article.getBoundingClientRect().left + 20,
        y: main.getBoundingClientRect().bottom - 20,
      };
    });
    await page.mouse.click(point.x, point.y);
    const body = editor(page, "Markdown 正文");
    await expect(body).toBeFocused();
    const caretVisible = await body.evaluate((el) => {
      const caret = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const viewport = el.closest("main")!.getBoundingClientRect();
      return caret.height > 0 && caret.top >= viewport.top && caret.bottom <= viewport.bottom;
    });
    expect(caretVisible).toBe(true);
    await page.keyboard.insertText("初");
    await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(source + "初");
  });
}

async function checkReadingInsertion(
  page: Page,
  note: Awaited<ReturnType<typeof createNote>>,
  point: { x: number; y: number },
  offset: number,
) {
  const { markdown, revision } = note.document;
  const body = editor(page, "Markdown 正文");
  await page.mouse.click(point.x, point.y);
  await expect(body).toBeFocused();
  await body.press("Control+s");
  expect(await readNote(page, note.apiUrl)).toMatchObject({ markdown, revision });
  await page.keyboard.insertText("【落点】");
  const saved = () => expect.poll(async () => (await readNote(page, note.apiUrl)).markdown);
  await saved().toBe(markdown.slice(0, offset) + "【落点】" + markdown.slice(offset));
  await body.press("Control+z");
  await saved().toBe(markdown);
}

for (const width of [1440, 390]) {
  for (const side of ["left", "right"] as const) {
    test(`reading paper at the ${side} page edge targets the wrapped visual line at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const text = "沿河逐站记下晨间水位。".repeat(17);
      const original =
        "\uFEFF---\r\ntitle: 河岸校对\r\n---\r\n\r\n前言。\r\n\r\n**" +
        text +
        "**\r\n\r\n结语。\r\n";
      const note = await createNote(page, `Wrap-${side}-${width}.md`, original);
      const passage = page.getByRole("article").getByText(text, { exact: true });
      await passage.scrollIntoViewIfNeeded();
      const point = await passage.evaluate((el, side) => {
        const node = el.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(node);
        // Measure a middle visual line independently of the browser's nearest-caret API.
        const lines = range.getClientRects();
        if (lines.length < 3) throw new Error("Expected at least three wrapped lines");
        const line = lines[1]!;
        const y = line.top + line.height / 2;
        const offsets: number[] = [];
        for (let i = 0; i < node.textContent!.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const glyph = range.getBoundingClientRect();
          if (glyph.top <= y && y < glyph.bottom) offsets.push(i);
        }
        if (!offsets.length) throw new Error("Expected visible characters on the second line");
        const main = el.closest("main")!;
        const viewport = main.getBoundingClientRect();
        const x = side === "left" ? viewport.left + 4 : viewport.left + main.clientWidth - 4;
        if (x >= line.left && x <= line.right)
          throw new Error("Expected a gutter outside the text");
        return { x, y, offset: side === "left" ? offsets[0]! : offsets.at(-1)! + 1 };
      }, side);
      await checkReadingInsertion(page, note, point, original.indexOf(text) + point.offset);
    });
  }
}

test("reading paper just past the text ends the short line inside the body column", async ({
  page,
}) => {
  const passage = "第一个短句。";
  const original = passage + "\r\n\r\n下一段。\r\n";
  const note = await createNote(page, "Short-line.md", original);
  const point = await page
    .getByRole("article")
    .getByText(passage, { exact: true })
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const x = text.right + 12;
      if (x >= el.getBoundingClientRect().right)
        throw new Error("Expected space inside the paragraph");
      return { x, y: text.top + text.height / 2 };
    });
  await checkReadingInsertion(page, note, point, passage.length);
});

for (const nearer of ["upper", "lower"] as const) {
  test(`the ${nearer} edge of a real blank line targets its source line`, async ({ page }) => {
    const upper = "上段**重点**收尾。";
    const lower = "下段从这里开始。";
    const original = "\uFEFF" + upper + "\r\n\r\n" + lower;
    const note = await createNote(page, `Gap-${nearer}.md`, original);
    const point = await page.getByRole("article").evaluate((article, nearer) => {
      const [upper, lower] = article.querySelectorAll("p");
      const top = upper!.getBoundingClientRect().bottom;
      const bottom = lower!.getBoundingClientRect().top;
      if (bottom - top < 6) throw new Error("Expected space between paragraphs");
      const column = article.getBoundingClientRect();
      return {
        x: nearer === "upper" ? column.left + 8 : column.right - 8,
        y: nearer === "upper" ? top + 2 : bottom - 2,
      };
    }, nearer);
    const offset = original.indexOf("\r\n") + 2;
    await checkReadingInsertion(page, note, point, offset);
  });
}

test("reading paper above the title targets the beginning of the first body paragraph", async ({
  page,
}) => {
  const prefix = "\uFEFF---\r\ntitle: 开头落点\r\n---\r\n\r\n";
  const note = await createNote(page, "Before-first.md", prefix + "第一段。\r\n\r\n末段。");
  const heading = page.getByRole("main").getByRole("heading", { name: "开头落点", exact: true });
  const point = await heading.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const text = range.getBoundingClientRect();
    const x = text.left + 8;
    const y = Math.min(text.top, el.getBoundingClientRect().top) - 6;
    if (el.contains(document.elementFromPoint(x, y)))
      throw new Error("Expected space above the title");
    return { x, y };
  });
  await checkReadingInsertion(page, note, point, prefix.length);
});

test("reading paper at the viewport bottom targets the nearby passage while more text follows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const original = Array.from({ length: 60 }, (_, i) => `沿岸第${i + 1}站。`).join("\n\n");
  const note = await createNote(page, "Fold.md", original);
  const passage = "沿岸第31站。";
  const point = await page
    .getByRole("article")
    .getByText(passage, { exact: true })
    .evaluate((el) => {
      const main = el.closest("main")!;
      const bottom = main.getBoundingClientRect().bottom;
      main.scrollTop += el.getBoundingClientRect().bottom - (bottom - 10);
      const upper = el.getBoundingClientRect();
      const lower = el.parentElement!.querySelectorAll("p")[31]!.getBoundingClientRect();
      const y = upper.bottom + 2;
      if (bottom - y > 10 || y >= bottom || lower.top <= bottom)
        throw new Error("Expected a gap at the fold with the next paragraph below it");
      return { x: upper.left + 8, y };
    });
  await checkReadingInsertion(page, note, point, original.indexOf(passage) + passage.length + 1);
});

test("document controls, modified clicks and native text selection keep the reader intact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await createNote(page, "Paper-reading.md", "选择这一整段文字。");
  const article = page.getByRole("article");
  const body = editor(page, "Markdown 正文");
  const { left, right, y, bottom } = await article.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("p")!);
    const box = range.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      y: box.top + box.height / 2,
      bottom: element.closest("main")!.getBoundingClientRect().bottom - 32,
    };
  });
  await page.getByRole("button", { name: "文档更多" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(body).toHaveCount(0);
  await page.mouse.click(left, bottom, { button: "right" });
  await page.keyboard.press("Escape");
  await page.keyboard.down("Alt");
  await page.mouse.click(left, bottom);
  await page.keyboard.up("Alt");
  await page.mouse.move(left + 1, y);
  await page.mouse.down();
  await page.mouse.move(right - 1, y, { steps: 6 });
  await page.mouse.up();
  await expect(body).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("选择这一整段文字。");
});

test("finishes an active IME composition before leaving the editor on blur", async ({ page }) => {
  await createNote(page, "CompositionBlur.md", "继续记录。\n");
  const article = page.getByRole("article");
  await article.getByText("继续记录。").click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await expect(body).toBeFocused();
  await body.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
  );
  await page.getByRole("button", { name: "文档更多" }).focus();
  await expect(body).toBeVisible();
  await body.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await expect(article).toBeVisible();
  await expect(page.getByRole("button", { name: "文档更多" })).toBeFocused();
});

test("save response keeps edits typed while waiting", async ({ page }) => {
  const before = "\uFEFF---\r\ntitle: 测试慢保存\r\n---\r\n初稿";
  const { apiUrl, document } = await createNote(page, "SaveQueue.md", before);
  const writes: { markdown: string; baseRevision: string }[] = [];
  let releaseFirst = () => {};
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let afterFirst = "";
  await page.route(`**${apiUrl}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const write = route.request().postDataJSON() as (typeof writes)[number];
    writes.push(write);
    const response = await route.fetch();
    if (writes.length === 1) {
      afterFirst = ((await response.json()) as DocumentSnapshot).revision;
      await held;
    }
    await route.fulfill({ response });
  });
  await page
    .getByRole("article")
    .getByText("初稿")
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  try {
    await body.press("Control+End");
    await page.keyboard.insertText("甲");
    await expect.poll(() => writes.length).toBe(1);
    await page.keyboard.insertText("乙");
    expect(writes).toEqual([{ markdown: before + "甲", baseRevision: document.revision }]);
  } finally {
    releaseFirst();
  }
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(before + "甲乙");
  await expect(page.getByText("已保存")).toBeVisible();
  expect(writes).toEqual([
    { markdown: before + "甲", baseRevision: document.revision },
    { markdown: before + "甲乙", baseRevision: afterFirst },
  ]);
  await page.reload();
  await expect(page.getByRole("article")).toContainText("初稿甲乙");
});

test("outline and body use independent revisions and sessions", async ({ page }) => {
  const before = "# 记录\n\n正文保持原样。\n";
  const { apiUrl, document } = await createNote(page, "IndependentOutline.md", before);
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "添加提纲" }).click();
  const outline = editor(page, "Markdown 提纲");
  await expect(outline).toBeFocused();
  await page.keyboard.insertText("写作提纲");
  const persisted = async () =>
    (await (await page.request.get(`${apiUrl}/outline`)).json()) as OutlineSnapshot;
  await expect.poll(async () => (await persisted()).markdown).toBe("写作提纲");
  await expect(page.getByText("已保存")).toBeVisible();
  await closeDocumentTool(page);
  await expect(outline).toHaveCount(0);
  await openDocumentTool(page, "提纲");
  await expect(outline).toBeVisible();
  await outline.press("Control+z");
  await expect.poll(async () => (await persisted()).markdown).toBe("");
  expect(await readNote(page, apiUrl)).toEqual({
    ...document,
    document: { ...document.document, outlineEnabled: true },
  });
});

test("source mode reuses the selection and undo history", async ({ page }) => {
  const { apiUrl } = await createNote(page, "SourceMode.md", "---\ntitle: 同一会话\n---\n\n初稿\n");
  await page
    .getByRole("article")
    .getByText("初稿")
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await page.keyboard.insertText("可撤销");
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "完整源码" }).click();
  await expect(body).toContainText("title: 同一会话");
  await expect(body).toBeFocused();
  await body.press("Control+z");
  await expect(body).not.toContainText("可撤销");
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe("---\ntitle: 同一会话\n---\n\n初稿\n");
});

test("connectivity loss retains the draft and reconnect saves it", async ({ page, context }) => {
  const { apiUrl } = await createNote(page, "OfflineDraft.md", "离线前的正文");
  await page
    .getByRole("article")
    .getByText("离线前的正文")
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await context.setOffline(true);
  await page.keyboard.insertText("，本地续写");
  await expect(page.getByRole("alert")).toContainText("网络恢复后会重试");
  await expect(body).toContainText("本地续写");
  expect((await readNote(page, apiUrl)).markdown).toBe("离线前的正文");
  await context.setOffline(false);
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe("离线前的正文，本地续写");
  await expect(page.getByText("已保存")).toBeVisible();
});

test("a stale save keeps the local buffer and the remote file", async ({ page }) => {
  const { apiUrl, document, origin } = await createNote(page, "StaleBody.md", "共同原件");
  await page
    .getByRole("article")
    .getByText("共同原件")
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  const remote = await page.request.put(apiUrl, {
    headers: { origin },
    data: { markdown: "远程版本", baseRevision: document.revision },
  });
  expect(remote.ok()).toBe(true);
  await page.keyboard.insertText("本地草稿");
  await expect(page.getByRole("alert")).toContainText("服务器上的正文已更新");
  await expect(body).toContainText("共同原件本地草稿");
  expect((await readNote(page, apiUrl)).markdown).toBe("远程版本");
});

test("adding a tag through the document uses a byte-preserving save", async ({ page }) => {
  const before =
    "\uFEFF---\r\ntitle: 文件属性 # 备注\r\ntags: note design  # 原标签\r\nx-custom: [1, 2]\r\n---\r\n真实正文  \n";
  const { apiUrl } = await createNote(page, "MetadataForm.md", before);
  await page.getByRole("button", { name: "文档更多" }).click();
  await page.getByRole("menuitem", { name: "文档属性" }).click();
  await page.getByLabel("添加标签").fill("河岸");
  await page.getByRole("button", { name: "保存属性" }).click();
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe(before.replace("note design ", "note design 河岸 "));
});

test("a failed workspace refetch leaves the live draft mounted", async ({ page }) => {
  const { apiUrl } = await createNote(page, "RefetchDraft.md", "本地编辑");
  await page
    .getByRole("article")
    .getByText("本地编辑")
    .click({ position: { x: 8, y: 16 } });
  const body = editor(page, "Markdown 正文");
  await body.press("Control+End");
  await page.route(`**${apiUrl}`, (route) =>
    route.request().method() === "PUT" ? route.abort("failed") : route.continue(),
  );
  await page.keyboard.insertText("继续保留");
  await expect(page.getByRole("alert")).toContainText("保存失败");
  await page.clock.install();
  await page.clock.fastForward(21_000);
  await page.route("**/api/v1/workspaces", (route) =>
    route.fulfill({
      status: 503,
      json: { code: "test_unavailable", message: "Temporary outage" },
    }),
  );
  const request = page.waitForResponse(
    (response) => response.url().endsWith("/api/v1/workspaces") && response.status() === 503,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await request;
  await expect(body).toContainText("本地编辑继续保留");
});

test("full source distinguishes a character from blank space on the same line", async ({
  page,
}) => {
  const initial = "甲乙丙丁\r\n\r\n文末。";
  const { apiUrl } = await createNote(page, "SourcePaper.md", initial);
  await page.getByRole("article").press("Alt+Shift+e");
  const body = editor(page, "Markdown 正文");
  const line = body.getByText("甲乙丙丁", { exact: true });
  const { at, after, y } = await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    range.setStart(el.firstChild!, 2);
    range.collapse(true);
    return {
      at: range.getBoundingClientRect().x + 1,
      after: rect.right + 12,
      y: rect.top + rect.height / 2,
    };
  });
  await page.mouse.click(at, y);
  await page.keyboard.insertText("中");
  const edited = initial.replace("乙", "乙中");
  await expect.poll(async () => (await readNote(page, apiUrl)).markdown).toBe(edited);
  await page.mouse.click(after + 40, y);
  await expect(body).toBeFocused();
  await page.keyboard.insertText("行尾");
  await expect
    .poll(async () => (await readNote(page, apiUrl)).markdown)
    .toBe(edited.replace("丙丁", "丙丁行尾"));
});

test("blank paper in a read-only note keeps the original revision", async ({ page }) => {
  const { apiUrl, origin, document } = await createNote(
    page,
    "ReadonlyPaper.md",
    "只读的文字。",
    "另一空间",
  );
  await page.context().clearCookies();
  const login = await page.request.post("/.auth/librarian/login", {
    headers: { origin },
    form: { username: "offline-reader", password: "offline-reader-test-password" },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  await page.reload();
  const article = page.getByRole("article");
  const paragraph = article.getByText("只读的文字。");
  await paragraph.click({ position: { x: 8, y: 16 } });
  await paragraph.click();
  await expect(article).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Markdown 正文" })).toHaveCount(0);
  expect((await readNote(page, apiUrl)).revision).toBe(document.revision);
});

test("the title and companion column keep their own pointer interactions", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  const { apiUrl, document: original } = await createNote(
    page,
    "页面点击范围.md",
    "由正文纸面接收输入。",
  );
  const heading = page
    .getByRole("main")
    .getByRole("heading", { name: "页面点击范围", exact: true });
  await heading.click({ position: { x: 10, y: 20 } });
  const body = editor(page, "Markdown 正文");
  await expect(body).toHaveCount(0);
  await openDocumentTool(page, "引用");
  const pane = page.getByRole("region", { name: "文档辅助区" });
  await pane.getByRole("heading", { name: "引用本篇" }).click();
  const box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 20);
  await expect(body).toHaveCount(0);
  await expect(page.getByRole("article")).toBeVisible();
  expect((await readNote(page, apiUrl)).revision).toBe(original.revision);
});
