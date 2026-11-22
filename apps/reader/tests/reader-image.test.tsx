import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { analyzeMarkdown } from "../src/markdown/analyze";
import { ReaderImage } from "../src/markdown/ReaderImage";
import { ReaderSurface } from "../src/markdown/ReaderSurface";

test("shows alt text when an image cannot load", () => {
  render(<ReaderImage src="/missing.png" alt="河岸" />);
  fireEvent.error(screen.getByRole("img", { name: "河岸" }));
  expect(screen.getByText("河岸")).toBeTruthy();
});

test("does not render a local image type the reader cannot inline", () => {
  const analysis = analyzeMarkdown("![图标](assets/icon.svg)\n", "doc");
  render(<ReaderSurface analysis={analysis} resolveImage={() => null} />);
  expect(screen.getByText("图标")).toBeTruthy();
});
