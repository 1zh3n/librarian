import { expect, test } from "vitest";
import { markdownForImages } from "../src/features/document/imageInsert";
import { relativeAssetPath, relativeDocumentPath } from "../src/markdown/relativePath";

const asset = (path: string) =>
  ({ path, revision: "a".repeat(64) }) as Parameters<typeof markdownForImages>[1][number];

test("resolves workspace assets relative to the document directory", () => {
  expect(relativeAssetPath("notes/field.md", "notes/assets/photo.png")).toBe("assets/photo.png");
  expect(relativeAssetPath("field/sub/note.md", "field/shared/photo.png")).toBe(
    "../shared/photo.png",
  );
  expect(relativeAssetPath("note.md", "assets/photo.png")).toBe("assets/photo.png");
  expect(relativeDocumentPath("notes/note.md", "assets/photo.png")?.path).toBe(
    "notes/assets/photo.png",
  );
});

test("builds stable Markdown for Unicode, spaces, parentheses and brackets", () => {
  expect(
    markdownForImages("notes/note.md", [
      asset("notes/assets/河岸 photo (1).png"),
      asset("notes/assets/a[b].webp"),
    ]),
  ).toBe(
    "![河岸 photo (1)](assets/%E6%B2%B3%E5%B2%B8%20photo%20%281%29.png)\n\n" +
      "![a\\[b\\]](assets/a%5Bb%5D.webp)",
  );
});
