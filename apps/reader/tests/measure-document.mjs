import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";

const origin = process.env.LIBRARIAN_PERF_ORIGIN;
assert.ok(origin, "Set LIBRARIAN_PERF_ORIGIN to the local reader_fixture server");
const expectedDist = fileURLToPath(new URL("../dist/", import.meta.url));
const plainSample = "## 河边的笔记\n\n清晨潮水尚低，芦苇间有几只鸟。**记录**风向和水位。\n\n";
const sample = process.env.LIBRARIAN_PERF_RICH_PATTERN
  ? plainSample.replace("笔记", "**笔记**")
  : plainSample;
const markdown = sample.repeat(Math.ceil(100_000 / sample.length)).slice(0, 100_000);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  console.log(
    "suite",
    JSON.stringify({
      chrome: browser.version(),
      markdownLength: markdown.length,
      markdownBytes: Buffer.byteLength(markdown),
      sha256: hash(markdown),
      entry: "Alt+E / Escape",
    }),
  );
  page.on("pageerror", (error) => console.error(error));
  await page.goto(origin + "/.auth/librarian/login");
  await page.getByLabel("用户名").fill("reader");
  await page.getByLabel("密码").fill("reader-test-password");
  const loggedIn = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/.auth/librarian/login"),
  );
  await page.getByRole("button", { name: "登录" }).click();
  assert.equal((await loggedIn).status(), 303);
  const spaces = await (await page.request.get(origin + "/api/v1/workspaces")).json();
  const { id: workspace } = spaces.find((space) => space.name === "田野笔记");
  const created = await page.request.post(
    origin + "/api/v1/workspaces/" + workspace + "/documents",
    {
      headers: { origin },
      data: { path: "Performance " + Date.now() + ".md", markdown, baseRevision: null },
    },
  );
  assert.equal(created.status(), 201);
  const { document } = await created.json();
  const apiPath = origin + "/api/v1/documents/" + document.id;
  const path = origin + "/workspaces/" + workspace + "/documents/" + document.id;
  const shell = await page.request.get(path);
  const expected = await readFile(join(expectedDist, "index.html"), "utf8");
  assert.equal(await shell.text(), expected);
  for (const asset of await readdir(join(expectedDist, "assets"))) {
    const live = await page.request.get(origin + "/assets/" + asset);
    assert.equal(live.status(), 200);
    assert.equal(
      hash(await live.body()),
      hash(await readFile(join(expectedDist, "assets", asset))),
    );
  }
  await page.goto(path);
  const article = page.getByRole("article");
  await article.waitFor();
  console.log("blocks", await article.locator("[data-block-id]").count());
  const editor = page.getByRole("textbox", { name: "Markdown 正文" });
  const waitAnimation = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await page.evaluate(() => {
    window.samples = [];
    const visible = () => !!document.querySelector("main article:not([hidden])");
    const record = (event, type) => {
      const start = performance.now();
      const anchorVisible = visible();
      const entryAnchor = document.querySelector("main")?.scrollTop;
      const pollSurface = () => {
        if (type !== "input" && visible() !== (type === "leave")) {
          requestAnimationFrame(pollSurface);
          return;
        }
        requestAnimationFrame(() => {
          window.samples.push({
            type,
            elapsed: performance.now() - start,
            start,
            anchorVisible,
            surfaceVisible: visible(),
            entryAnchor,
          });
        });
      };
      requestAnimationFrame(pollSurface);
    };
    addEventListener("input", (event) => record(event, "input"), true);
    addEventListener(
      "keydown",
      (event) => {
        if (event.altKey && event.key.toLowerCase() === "e") record(event, "enter");
        if (event.key === "Escape" && !visible()) record(event, "leave");
      },
      true,
    );
  });
  const enter = () => page.keyboard.press("Alt+e");
  const leave = () => page.keyboard.press("Escape");
  let count = 0;
  const flush = () => page.waitForFunction((n) => window.samples.length >= n, ++count);
  await enter();
  await flush();
  let expectedMarkdown = markdown;
  function insertTextInExpectedSource(text, at) {
    expectedMarkdown = expectedMarkdown.slice(0, at) + text + expectedMarkdown.slice(at);
  }
  for (let i = 0; i < 20; i++) {
    const text = i % 2 ? "水" : "潮";
    await page.keyboard.insertText(text);
    insertTextInExpectedSource(text, i);
    await flush();
  }
  await leave();
  await flush();
  for (let i = 0; i < 4; i++) {
    await enter();
    await flush();
    await page.keyboard.press("Control+Home");
    await page.keyboard.insertText("。");
    insertTextInExpectedSource("。", 0);
    await flush();
    await leave();
    await flush();
  }
  const values = await page.evaluate(() => window.samples);
  const report = (key, items) => {
    const ms = items.map((x) => Number((typeof x === "number" ? x : x.elapsed).toFixed(1)));
    const sorted = [...ms].sort((a, b) => a - b);
    const quantile = (q) => sorted[Math.ceil(ms.length * q) - 1];
    console.log(key, JSON.stringify({ n: ms.length, p50: quantile(0.5), p95: quantile(0.95), ms }));
  };
  report("input", values.filter((x) => x.type === "input").slice(0, 20));
  report(
    "switch",
    values.filter((x) => x.type !== "input"),
  );
  report(
    "enter",
    values.filter((x) => x.type === "enter"),
  );
  report(
    "leave",
    values.filter((x) => x.type === "leave"),
  );
  let actualMarkdown;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const response = await page.request.get(apiPath);
    if (response.ok()) actualMarkdown = (await response.json()).markdown;
    if (actualMarkdown === expectedMarkdown) break;
    await setTimeout(100);
  }
  assert.equal(
    hash(actualMarkdown ?? ""),
    hash(expectedMarkdown),
    "saved Markdown bytes match expected",
  );
  console.log("saved sha256", hash(actualMarkdown));

  const target = article.locator("[data-block-id]").nth(1200);
  const expectedInset = await target.evaluate((el) => {
    const viewport = el.closest("main");
    viewport.scrollTop +=
      el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 32;
    return el.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  });
  const source = await target.textContent();
  await page.keyboard.press("Alt+e");
  await editor.waitFor();
  await waitAnimation();
  await waitAnimation();
  const editorInset = await editor.evaluate(
    (editor, { source, expectedInset }) => {
      const main = editor.closest("main");
      return Math.min(
        ...Array.from(editor.querySelectorAll(".cm-line")).flatMap((el) => {
          const inset = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
          return el.textContent.trim() === source.trim() ? [Math.abs(inset - expectedInset)] : [];
        }),
      );
    },
    { source, expectedInset },
  );
  const beforeKeyboardExit = await editor.evaluate((el) => el.closest("main").scrollTop);
  await page.keyboard.press("Escape");
  await waitAnimation();
  const actualInset = await target.evaluate(
    (el) => el.getBoundingClientRect().top - el.closest("main").getBoundingClientRect().top,
  );
  console.log(
    "anchor",
    JSON.stringify({
      expectedInset,
      actualInset,
      beforeKeyboardExit,
      editorError: Number.isFinite(editorInset) ? editorInset : String(editorInset),
      finalError: Math.abs(actualInset - expectedInset),
    }),
  );
} finally {
  await browser.close();
}
