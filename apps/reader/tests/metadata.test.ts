import { expect, it } from "vitest";
import { applyTextEdits } from "../src/editor/document";
import { metadataEdits, readMetadata } from "../src/features/document/metadata";

it("adding a tag preserves other Front Matter and body bytes", () => {
  const source =
    '\uFEFF---\r\ntitle: "原题" # 标题\r\ntags: note design  # 旧标签\r\nunknown: |\r\n  自定义\r\n---\r\n# 正文\n尾随空白  \r';
  const edits = metadataEdits(source, { addTag: "田野" });
  expect(edits).toHaveLength(1);
  expect(applyTextEdits(source, edits)).toBe(source.replace("note design ", "note design 田野 "));
  expect(metadataEdits(source, { addTag: "design" })).toEqual([]);
});

it("adds a tag to a block list while preserving comments", () => {
  const source = "---\ntags:\n  - note # 备注\n  - design\nseries: 河岸\n---\n正文";
  const revised = applyTextEdits(source, metadataEdits(source, { addTag: "田野" }));
  expect(revised).toBe(source.replace("  - design\n", "  - design\n  - 田野\n"));
  expect(readMetadata(revised).tags).toEqual(["note", "design", "田野"]);
});

it("creates Front Matter for explicit metadata while preserving text and BOM", () => {
  const source = "\uFEFF# 正文\r\n原文  ";
  expect(applyTextEdits(source, metadataEdits(source, { title: "新题", status: "ready" }))).toBe(
    "\uFEFF---\r\ntitle: 新题\r\nstatus: ready\r\n---\r\n# 正文\r\n原文  ",
  );
});

it("sends malformed metadata to the source editor without a rewrite", () => {
  const source = "---\nunknown: [broken\n---\n正文";
  expect(readMetadata(source).invalid).toBe(true);
  expect(() => metadataEdits(source, { title: "新题" })).toThrow();
});
