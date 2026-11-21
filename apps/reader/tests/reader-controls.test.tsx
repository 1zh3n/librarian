import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Button } from "../src/ui/Button";

afterEach(cleanup);

test("a loading action stays focusable and ignores repeat activation", () => {
  const action = vi.fn();
  const { rerender } = render(
    <Button loading onPress={action}>
      正在保存
    </Button>,
  );
  const button = screen.getByRole("button", { name: "正在保存" });
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(button);
  expect(action).not.toHaveBeenCalled();
  rerender(<Button onPress={action}>保存</Button>);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(action).toHaveBeenCalledOnce();
});
