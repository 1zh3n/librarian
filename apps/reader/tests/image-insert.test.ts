import { expect, test } from "vitest";
import {
  imageValidationError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
} from "../src/features/document/imageInsert";

function file(name: string, size = 4) {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

test("validates image count, extensions and size before uploading", () => {
  expect(imageValidationError([])).toContain("请选择");
  expect(imageValidationError([file("photo.svg")])).toContain("仅支持");
  expect(imageValidationError([file("photo.png", MAX_IMAGE_BYTES + 1)])).toContain("12 MiB");
  expect(
    imageValidationError(
      Array.from({ length: MAX_IMAGES + 1 }, (_, index) => file(`${index}.png`)),
    ),
  ).toContain("最多");
  expect(imageValidationError([file("photo.png"), file("other.avif")])).toBeUndefined();
});
