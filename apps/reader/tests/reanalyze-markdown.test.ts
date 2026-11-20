import { expect, test, vi } from "vitest";
import * as markdown from "../src/markdown/analyze";
import { reanalyzeMarkdown } from "../src/markdown/reanalyze";

const documentId = "test/doc-with-dashes";

test.each([
  ["## 河边\n\n段落\n\n## 河边\n", "新## 河边\n\n段落\n\n## 河边\n"],
  ["首行\n\n段落\n\n尾行", "首行\n\n段落。\n\n尾行"],
  ["首行\n\n段落甲\n\n尾行", "首行\n\n段落\n\n尾行"],
  ["首行\n\n段落甲\n\n尾行", "首行\n\n改为乙\n\n尾行"],
  ["## 河边甲\n\n段落", "## 河边的新位置\n\n段落"],
  ["## 河边\n\n正文 🏞️\n\n## 河边", "## 河边\n\n正文 🏞️\n\n## 河边。"],
  ["## 河边 ###\n\n段落", "## 河边 ###字\n\n段落"],
  [
    "\uFEFF---\r\ntitle: note\r\n---\r\n\r\n## Anchor\n\n河边\n\n[link][x] and 🏞️.\n\n[x]: https://example.test/\r\n",
    "\uFEFF---\r\ntitle: note\r\n---\r\n\r\n## Anchor\n\n河边潮水\n\n[link][x] and 🏞️.\n\n[x]: https://example.test/\r\n",
  ],
])("matches complete analysis after a change confined to one simple line", (source, changed) => {
  const previous = { source, analysis: markdown.analyzeMarkdown(source, documentId) };
  const expected = markdown.analyzeMarkdown(changed, documentId);
  const analyze = vi.spyOn(markdown, "analyzeMarkdown");
  try {
    const result = reanalyzeMarkdown(changed, documentId, previous);
    expect(result).toEqual(expected);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
  } finally {
    analyze.mockRestore();
  }
});

test.each([
  ["字\n\n继续", "> 字\n\n继续"],
  ["## 河边\r\n\r\n清晨", "## 河边潮水\r\n\r\n清晨"],
  ["一段\n\n[x]: https://example.test/", "一段\n\n[x]: https://example.test/河边"],
  ["段落第一行\n续行", "段落第一行涨潮\n续行"],
  ["一段\n\n另一段", "一段甲\n\n另一段乙"],
  ["河边\n\n清晨", "清晨"],
  ["河边\n\n清晨", "河边甲\n\n\n清晨"],
  ["河边\n\n清晨", "    河边\n\n清晨"],
  ["河边\n\n清晨", "河边  \n\n清晨"],
])("falls back to a full parse for edits outside the isolated case", (source, changed) => {
  const previous = { source, analysis: markdown.analyzeMarkdown(source, documentId) };
  const expected = markdown.analyzeMarkdown(changed, documentId);
  const analyze = vi.spyOn(markdown, "analyzeMarkdown");
  try {
    expect(reanalyzeMarkdown(changed, documentId, previous)).toEqual(expected);
    expect(analyze).toHaveBeenCalledExactlyOnceWith(changed, documentId);
  } finally {
    analyze.mockRestore();
  }
});

test("reuses the entire analysis for unchanged source", () => {
  const source = "# 读者\n";
  const previous = { source, analysis: markdown.analyzeMarkdown(source, documentId) };
  expect(reanalyzeMarkdown(source, documentId, previous)).toBe(previous.analysis);
});

test("falls back when the previous analysis belongs to another document", () => {
  const source = "# 读者\n";
  const analysis = markdown.analyzeMarkdown(source, "test/doc-with-dashes/other");
  expect(reanalyzeMarkdown(source, documentId, { source, analysis })).toEqual(
    markdown.analyzeMarkdown(source, documentId),
  );
});

test("keeps rich Markdown and repeated anchors identical through consecutive local edits", () => {
  const line = "## 河边";
  let source = [
    line,
    "Read [the notes][notes] and a footnote.[^field]",
    "| Morning | Tide |\n| --- | --- |\n| 江岸📝 | Low |",
    "> A quote\n>\n> - [x] Done",
    line,
    "```md\n## Not a heading\n```",
    line,
    "[notes]: https://example.test/notes",
    "[^field]: One footnote.",
  ].join("\n\n");
  let analysis = markdown.analyzeMarkdown(source, documentId);

  for (const change of [
    (text: string) => text.replace("## 河边", "涨潮## 河边"),
    (text: string) => text.replace("涨潮## 河边", "涨潮## 河边。"),
    (text: string) => text.replace("## 河边\n\n```md", "## 河边𠮷\n\n```md"),
  ]) {
    const next = change(source);
    analysis = reanalyzeMarkdown(next, documentId, { source, analysis });
    expect(analysis).toEqual(markdown.analyzeMarkdown(next, documentId));
    source = next;
  }
});
