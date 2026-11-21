import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { api, type AiOperation } from "../src/api/client";
import { AiOperationReceipt } from "../src/features/ai/AiOperationReceipt";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    state: _state,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params: Record<string, string>;
    state?: unknown;
  }) => <a {...props} href={to.replace(/\$(\w+)/gu, (_, key: string) => params[key] ?? "")} />,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const operation: AiOperation = {
  id: "request",
  scope: "global",
  mode: "edit",
  status: "needs_confirmation",
  sources: [],
  documentId: null,
  answer: null,
  commitId: null,
  undoCommitId: null,
  changes: [],
  confirmation: {
    id: "bound",
    paths: [],
    transfer: {
      kind: "copy",
      sourceKind: "document",
      documentId: "source-doc",
      sourceWorkspaceId: "source",
      sourceWorkspaceName: "田野",
      sourcePath: "资料/笔记.md",
      targetWorkspaceId: "target",
      targetWorkspaceName: "归档",
      targetPath: "笔记.md",
      fileCount: 2,
      access: { gainedRead: 1, gainedWrite: 0, lost: 2, upgraded: 0, downgraded: 0 },
    },
  },
};
test("copy preview shows the original, destination and access difference; confirmation focuses the actual copy receipt", async () => {
  const result: AiOperation = {
    ...operation,
    status: "succeeded",
    confirmation: null,
    transferResult: {
      kind: "copy",
      workspaceId: "target",
      workspaceName: "归档",
      path: "笔记.md",
      documentId: "new-copy",
    },
  };
  const confirm = vi.spyOn(api, "confirmAiOperation").mockResolvedValue(result);
  const visited = vi.fn();
  function Turn() {
    const [current, update] = useState(operation);
    return (
      <AiOperationReceipt
        operation={current}
        writable
        update={update}
        afterCancel={vi.fn()}
        onVisit={visited}
      />
    );
  }
  render(<Turn />);
  const preview = within(screen.getByRole("region", { name: "待确认的操作" }));
  const origin = preview.getByRole("link", { name: /田野.*资料\/笔记.md/u });
  expect(origin.getAttribute("href")).toBe("/workspaces/source/documents/source-doc");
  fireEvent.click(origin);
  expect(visited).toHaveBeenCalledWith("transfer-source:request");
  expect(preview.getByText(/归档.*笔记.md/u)).toBeDefined();
  expect(preview.getByText(/2 个文件/u)).toBeDefined();
  expect(preview.getByText(/2 位原成员将无法访问副本/u)).toBeDefined();
  fireEvent.click(preview.getByRole("button", { name: "确认复制" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith("request", "bound"));
  const receipt = await screen.findByRole("region", { name: "操作回执" });
  expect(receipt.textContent).toContain("已复制");
  const link = within(receipt).getByRole("link", { name: /归档.*笔记.md/u });
  expect(link.getAttribute("href")).toBe("/workspaces/target/documents/new-copy");
  await waitFor(() => expect(document.activeElement).toBe(link));
  expect(screen.queryByRole("button", { name: /撤销/u })).toBeNull();
});

test("management receipts identify the actual space, account and resulting role", () => {
  render(
    <AiOperationReceipt
      operation={{
        ...operation,
        status: "succeeded",
        confirmation: null,
        workspaceManagement: {
          kind: "set_workspace_member",
          name: "田野资料",
          workspaceId: "field",
          username: "li",
          role: "read",
        },
      }}
      writable
      update={vi.fn()}
      afterCancel={vi.fn()}
    />,
  );
  const receipt = screen.getByRole("region", { name: "操作回执" });
  expect(receipt.textContent).toContain("li");
  expect(receipt.textContent).toContain("只读");
  expect(within(receipt).getByRole("link", { name: "田野资料" }).getAttribute("href")).toBe(
    "/workspaces/field",
  );
});
