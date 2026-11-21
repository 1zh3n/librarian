import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DiscoveredModel } from "../src/api/client";
import { ModelChoices } from "../src/features/settings/ModelChoices";

const model: DiscoveredModel = {
  id: "deepseek-flash",
  name: "DeepSeek-V4.1-Flash",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  contextWindow: 1_048_576,
  maxOutputTokens: 393_216,
  effort: {
    supportedLevels: ["low", "high", "max"],
    defaultLevel: "high",
  },
};

afterEach(cleanup);

test("model capabilities keep a compact summary and expand on demand", () => {
  render(
    <ModelChoices
      models={[model]}
      choice={{ modelId: model.id, thinking: { mode: "provider_default" } }}
      change={vi.fn()}
    />,
  );
  expect(screen.getByText(/输入 文本、图片/)).toBeTruthy();
  expect(screen.getByText(/1M 上下文/)).toBeTruthy();
  const content = screen.getByText("上下文窗口").closest("[data-slot='disclosure-content']");
  expect(content?.hasAttribute("hidden")).toBe(true);
  const trigger = screen.getByRole("button", { name: /模型能力/ });
  fireEvent.click(trigger);
  expect(content?.hasAttribute("hidden")).toBe(false);
  expect(screen.getByText("上下文窗口")).toBeTruthy();
  expect(screen.getByText("1,048,576 tokens")).toBeTruthy();
  expect(screen.getByText("393,216 tokens")).toBeTruthy();
  expect(screen.getByText("最大输出")).toBeTruthy();
});
