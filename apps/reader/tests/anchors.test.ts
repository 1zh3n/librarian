import { expect, test } from "vitest";
import { resolveAnchor } from "../src/markdown/anchors";
import { analyzeMarkdown } from "../src/markdown/analyze";

test("missing_block_uses_nearest_position", () => {
  const before = analyzeMarkdown("甲\n\n重复📝\n\n丙\n\n重复📝", "spike");
  const anchor = {
    blockId: before.blocks[1]!.id,
    sourceOffset: before.blocks[1]!.from,
    insetPx: 18,
  };
  const after = analyzeMarkdown("甲\n\n丙\n\n重复📝", "spike");

  expect(resolveAnchor(after.blocks, anchor, false)).toEqual(after.blocks[1]);
  expect(resolveAnchor(before.blocks, anchor, true)).toEqual(before.blocks[1]);
  expect(resolveAnchor([], anchor, false)).toBeUndefined();
});
