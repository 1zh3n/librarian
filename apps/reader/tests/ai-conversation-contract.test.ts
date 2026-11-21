// @vitest-environment node
import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { expect, test } from "vitest";
import type { Schema } from "@cfworker/json-schema";

const { components } = JSON.parse(
  readFileSync(new URL("../../../api/librarian.openapi.json", import.meta.url), "utf8"),
) as {
  components: { schemas: Record<string, Schema> };
};
function accepts(schema: string, payload: unknown) {
  return new Validator(
    { components, $ref: "#/components/schemas/" + schema } as Schema,
    "2020-12",
  ).validate(payload).valid;
}

test("a scope requires either a real workspace or explicit global identity", () => {
  for (const input of [{ workspaceId: "old", documentId: "doc" }, { scope: "global" }]) {
    expect(accepts("ConversationScope", input)).toBe(true);
  }
  for (const input of [
    {},
    { workspaceId: "" },
    { scope: "global", workspaceId: "old" },
    { scope: "global", documentId: "doc" },
  ]) {
    expect(accepts("ConversationScope", input)).toBe(false);
  }
});

test("managed claims allow global input while legacy tasks keep their required workspace", () => {
  const global = { mode: "chat", prompt: "compare", scope: "global" };
  expect(accepts("AiClaimInput", global)).toBe(true);
  expect(accepts("AiTask", global)).toBe(false);
  expect(accepts("AiClaimInput", { ...global, workspaceId: "old" })).toBe(false);
});

test("managed results accept one management or transfer action with the corresponding fields", () => {
  const valid = [
    { kind: "create_workspace", name: "New" },
    { kind: "set_workspace_member", workspaceId: "w", username: "reader", role: "read" },
    {
      kind: "copy",
      sourceWorkspaceId: "A",
      sourcePath: "f",
      sourceKind: "folder",
      targetWorkspaceId: "B",
      targetPath: "copies/f",
    },
    {
      kind: "move",
      sourceWorkspaceId: "A",
      sourcePath: "x.md",
      documentId: "old-id",
      targetWorkspaceId: "B",
      targetPath: "y.md",
    },
  ];
  for (const action of valid)
    expect(accepts("AiManagedResult", { answer: "ok", edits: [], action })).toBe(true);
  for (const action of [
    { ...valid[1], role: "manager" },
    { kind: "rename_workspace", name: "New" },
    { ...valid[2], sourceKind: "document" },
    { kind: "unknown" },
  ])
    expect(accepts("AiManagedResult", { answer: "ok", action })).toBe(false);
  expect(
    accepts("AiManagedResult", { answer: "ok", targetWorkspaceId: "w", action: valid[0] }),
  ).toBe(false);
});

test("a recipient can distinguish managed membership changes from transfers in receipts", () => {
  const operation = {
    id: "operation",
    documentId: null,
    mode: "edit",
    answer: "done",
    status: "succeeded",
    sources: [],
    changes: [],
    commitId: null,
    undoCommitId: null,
    confirmation: null,
  };
  for (const identity of [{ workspaceId: "w" }, { scope: "global" }]) {
    expect(
      accepts("AiOperation", {
        ...operation,
        ...identity,
        workspaceManagement: {
          kind: "remove_workspace_member",
          workspaceId: "w",
          name: "W",
          username: "reader",
        },
      }),
    ).toBe(true);
    expect(
      accepts("AiOperation", {
        ...operation,
        ...identity,
        workspaceManagement: {
          kind: "set_workspace_member",
          workspaceId: "w",
          name: "W",
          username: "reader",
          role: "admin",
        },
      }),
    ).toBe(false);
    expect(
      accepts("AiOperation", {
        ...operation,
        ...identity,
        transferResult: {
          kind: "move",
          workspaceId: "b",
          workspaceName: "B",
          path: "a.md",
          documentId: "doc",
        },
      }),
    ).toBe(true);
    expect(
      accepts("AiOperation", { ...operation, ...identity, transferResult: { kind: "share" } }),
    ).toBe(false);
  }
});
