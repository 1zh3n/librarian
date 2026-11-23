import { expect, test } from "vitest";
import type { AiTransferPreview, Workspace } from "../src/api/client";
import { canChangeGlobalReceipt } from "../src/features/ai/receiptPermissions";

const target: Workspace = {
  id: "target",
  name: "归档",
  spaceId: "target",
  canManage: false,
  canWrite: true,
  retention: "persistent",
  origin: "native",
  revisionMode: "managed",
  expiresAt: null,
  securityLevel: "internal",
  capabilities: {
    externalAi: true,
    externalMcp: true,
    anonymousShare: true,
    publication: false,
    offline: true,
    remoteBackup: true,
  },
  defaults: { outlineEnabled: true },
};
const source = { ...target, id: "source", name: "田野", canManage: true };
const transfer: AiTransferPreview = {
  kind: "copy",
  sourceWorkspaceId: source.id,
  sourceWorkspaceName: source.name,
  sourcePath: "笔记.md",
  targetWorkspaceId: target.id,
  targetWorkspaceName: target.name,
  targetPath: "笔记.md",
  sourceKind: "document",
  documentId: "note",
  fileCount: 1,
  access: { gainedRead: 0, gainedWrite: 0, lost: 0, upgraded: 0, downgraded: 0 },
};
test("undo requires write access to the operation's managed destination", () => {
  const op = { targetWorkspaceId: target.id, confirmation: null };
  expect(canChangeGlobalReceipt(op, [target])).toBe(true);
  expect(canChangeGlobalReceipt(op, [{ ...target, canWrite: false }])).toBe(false);
  expect(canChangeGlobalReceipt(op, [{ ...target, revisionMode: "repository" }])).toBe(false);
  expect(canChangeGlobalReceipt(op, [source])).toBe(false);
});
test("copy accepts a readable source, while move requires write and management on that source", () => {
  const copy = { confirmation: { id: "confirmation", paths: [], transfer } };
  const move = {
    confirmation: { ...copy.confirmation, transfer: { ...transfer, kind: "move" as const } },
  };
  const readOnly = {
    ...source,
    canWrite: false,
    canManage: false,
    revisionMode: "disabled" as const,
  };
  expect(canChangeGlobalReceipt(copy, [readOnly, target])).toBe(true);
  expect(canChangeGlobalReceipt(copy, [target])).toBe(false);
  expect(canChangeGlobalReceipt(move, [readOnly, target])).toBe(false);
  expect(canChangeGlobalReceipt(move, [{ ...source, canManage: false }, target])).toBe(false);
  expect(canChangeGlobalReceipt(move, [source, target])).toBe(true);
  expect(canChangeGlobalReceipt(move, [source, { ...target, canWrite: false }])).toBe(false);
});
