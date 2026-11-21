import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { readerCaretOffset, readerSelection } from "../src/features/ai/readerSelection";
import { analyzeMarkdown } from "../src/markdown/analyze";
import { ReaderSurface } from "../src/markdown/ReaderSurface";

afterEach(cleanup);

function selectCode(source: string, visible: string, start: number, end: number) {
  const analysis = analyzeMarkdown(source, "doc");
  const view = render(<ReaderSurface analysis={analysis} />);
  const root = view.getByRole("article");
  const text = root.querySelector("code")?.firstChild;
  if (!(text instanceof Text)) throw new Error("Expected rendered code");
  expect(text.data).toBe(visible);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return {
    selected: readerSelection(root, range, source, analysis),
    caret: readerCaretOffset(root, { node: text, offset: start }, source, analysis),
  };
}

test.each(["\n", "\r\n", "\r"])("selects only 乙 after a code-span line ending %j", (eol) => {
  const prefix = "\uFEFF😀前 `甲" + eol;
  const source = prefix + "乙丙` 后乙";
  const { selected, caret } = selectCode(source, "甲 乙丙", 2, 3);
  expect(selected).toEqual({ from: prefix.length, to: prefix.length + 1 });
  expect(caret).toBe(prefix.length);
});

test.each([
  { source: "`甲\r\n乙丙`", visible: "甲 乙丙", start: 1, end: 2, from: 2, to: 4 },
  { source: "`` 甲`\r\n乙 ``", visible: "甲` 乙", start: 0, end: 4, from: 3, to: 8 },
  { source: "前 `\r\n甲乙\r\n`", visible: "甲乙", start: 0, end: 2, from: 5, to: 7 },
  { source: "` \r\n `", visible: "   ", start: 1, end: 2, from: 2, to: 4 },
  { source: "`甲\n甲 乙\n甲`", visible: "甲 甲 乙 甲", start: 2, end: 5, from: 3, to: 6 },
  { source: "`\\*\n&amp;`", visible: "\\* &amp;", start: 1, end: 4, from: 2, to: 5 },
])(
  "maps rendered offsets [$start, $end) back into $source",
  ({ source, visible, start, end, from, to }) => {
    expect(selectCode(source, visible, start, end).selected).toEqual({ from, to });
  },
);

test.each([
  { source: "> `甲\r\n> 乙丙`", visible: "甲 乙丙", start: 2, end: 3, from: 8, to: 9 },
  { source: "> `甲\r\n> 乙丙`", visible: "甲 乙丙", start: 1, end: 2, from: 4, to: 6 },
  { source: "- `甲\n   乙丙`", visible: "甲  乙丙", start: 2, end: 4, from: 7, to: 9 },
])("maps code inside container markup in $source", ({ source, visible, start, end, from, to }) => {
  expect(selectCode(source, visible, start, end).selected).toEqual({ from, to });
});
