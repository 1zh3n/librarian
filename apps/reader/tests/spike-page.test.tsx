import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SpikePage } from "../src/spike/SpikePage";

afterEach(cleanup);

test("reopens the fixture after leaving the editor", () => {
  render(<SpikePage />);
  fireEvent.click(screen.getByRole("button", { name: "编辑正文" }));
  fireEvent.click(screen.getByRole("button", { name: "返回阅读" }));
  const article = screen.getByRole("article", { name: "测试文档" });
  expect(within(article).getByRole("heading", { name: "河边的笔记" })).toBeDefined();
});
