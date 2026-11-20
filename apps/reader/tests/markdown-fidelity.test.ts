import { expect, test } from "vitest";
import { openEditor } from "../src/editor/codemirror/adapter";
import { analyzeMarkdown } from "../src/markdown/analyze";
import { spikeMarkdown } from "../src/spike/fixture";
import { fidelityFixtures, mixedMarkdown, unsafeMarkup } from "./fixtures/markdown/fidelity";

const bytes = (text: string) => new TextEncoder().encode(text);

test.each(fidelityFixtures)("preserves_untouched_bytes ($name)", ({ markdown }) => {
  const editor = openEditor(markdown);
  expect(bytes(editor.source())).toEqual(bytes(markdown));
  editor.applyChanges([]);
  expect(bytes(editor.source())).toEqual(bytes(markdown));
});

test("maps_mixed_line_endings_and_emoji", () => {
  const editor = openEditor(mixedMarkdown);
  const emoji = mixedMarkdown.indexOf("😀");
  const end = mixedMarkdown.indexOf("尾行");
  editor.applyChanges([
    { from: emoji, to: emoji + 2, insert: "🌊" },
    { from: end, to: end + 1, insert: "最后\r\n一" },
  ]);
  expect(bytes(editor.source())).toEqual(
    bytes(
      "\uFEFF---\r\ntitle: 河边\n---\r\n\r\n# 河边的笔记 🌊\r\n\n<!-- 保留 -->\r\n\r\n清晨  \n\n[[未知扩展]]\r最后\r\n一行",
    ),
  );
  const heading = analyzeMarkdown(mixedMarkdown, "fixture").blocks[0];
  expect(heading?.kind).toBe("heading");
  expect(heading && mixedMarkdown.slice(heading.from, heading.to)).toBe("# 河边的笔记 😀");
});

test("preserves the two halves of a source CRLF when only one is changed", () => {
  const editor = openEditor("first\r\nsecond\r\nthird");
  editor.applyChanges([
    { from: 6, to: 7, insert: "" },
    { from: 13, to: 14, insert: "" },
  ]);
  expect(bytes(editor.source())).toEqual(bytes("first\rsecond\nthird"));
});

test("keeps_unknown_syntax_in_source", () => {
  const editor = openEditor(mixedMarkdown);
  const start = mixedMarkdown.indexOf("清晨");
  editor.applyChanges([{ from: start, to: start + 2, insert: "傍晚" }]);
  expect(editor.source()).toBe(mixedMarkdown.replace("清晨", "傍晚"));
  expect(editor.source()).toContain("<!-- 保留 -->");
  expect(editor.source()).toContain("[[未知扩展]]");
});

test("rejects_unsafe_html_and_links", () => {
  const { tree } = analyzeMarkdown(unsafeMarkup, "unsafe");
  const serialized = JSON.stringify(tree);
  expect(serialized).not.toContain("hiddenScriptText");
  expect(serialized).not.toContain('"tagName":"span"');
  expect(serialized).toContain("hiddenRawHtml");
  expect(serialized).not.toContain("javascript:");
  expect(serialized).not.toContain("data:text/html");
  expect(serialized).toContain("https://example.com/path");
});

test("assigns source ranges to rendered CommonMark and GFM blocks", () => {
  const { blocks, tree } = analyzeMarkdown(spikeMarkdown, "fixture");
  expect(blocks.map((block) => block.kind)).toEqual([
    "heading",
    "paragraph",
    "blockquote",
    "list",
    "table",
    "code",
  ]);
  expect(blocks.map(({ from, to }) => spikeMarkdown.slice(from, to).split("\n")[0])).toEqual([
    "# 河边的笔记",
    "清晨的水面很**安静**，沿着[小径](https://example.com/)走到了河边。",
    "> 别惊动停在芦苇里的鸟。",
    "- [x] 记下潮位",
    "| 地点 | 水位 |",
    "```text",
  ]);
  expect(
    tree.children.flatMap((child) => (child.type === "element" ? [child.tagName] : [])),
  ).toEqual(["h1", "p", "blockquote", "ul", "table", "pre"]);
});
