import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AiOperationReceipt } from "../src/features/ai/AiOperationReceipt";
import { api } from "../src/api/client";
import type { AiOperation } from "../src/api/client";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const preview: AiOperation = {
  id: "operation",
  workspaceId: "ws_field",
  documentId: null,
  mode: "edit",
  status: "needs_confirmation",
  sources: [],
  answer: null,
  commitId: null,
  undoCommitId: null,
  changes: [],
  confirmation: {
    id: "immutable-plan",
    paths: ["notes/field.md", "archive/field.md"],
    plan: {
      request: { kind: "move", from: "notes", to: "archive" },
      changes: [
        { path: "notes/field.md", beforeRevision: "abc", revision: null },
        { path: "archive/field.md", beforeRevision: null, revision: "abc" },
      ],
      pathLinks: [{ from: "plan.md", to: "notes/field.md" }],
      partialLinks: true,
    },
  },
};
function show(operation: AiOperation) {
  render(
    <AiOperationReceipt operation={operation} writable update={() => {}} afterCancel={() => {}} />,
  );
  return within(screen.getByRole("region", { name: "待确认的操作" }));
}
test("a move shows its source, destination, backlink and available decisions", () => {
  const plan = show(preview);
  expect(plan.getByText("notes → archive")).toBeDefined();
  expect(plan.getByRole("list", { name: "受影响的内链" }).textContent).toContain("plan.md");
  expect(plan.getByRole("button", { name: "确认移动" })).toBeDefined();
  expect(plan.getByRole("button", { name: "取消操作" })).toBeDefined();
});
test("a conflicting plan stays available for review and dismissal", () => {
  const plan = show({ ...preview, status: "conflict" });
  expect(plan.queryByRole("button", { name: /确认/ })).toBeNull();
  expect(plan.getByRole("button", { name: "取消操作" })).toBeDefined();
});

test("dismissal sends the reviewed confirmation ID and returns focus after the response", async () => {
  const canceled: AiOperation = { ...preview, confirmation: null, status: "canceled" };
  const cancel = vi.spyOn(api, "cancelAiConfirmation").mockResolvedValue(canceled);
  const update = vi.fn();
  const returnFocus = vi.fn();
  render(
    <AiOperationReceipt operation={preview} writable update={update} afterCancel={returnFocus} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "取消操作" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(canceled));
  expect(cancel).toHaveBeenCalledWith("operation", "immutable-plan");
  expect(returnFocus).toHaveBeenCalledOnce();
});
