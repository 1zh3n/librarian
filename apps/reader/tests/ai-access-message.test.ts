import { expect, test } from "vitest";
import { aiAccessMessage, ApiError } from "../src/api/client";

test.each([
  [401, "unauthorized", "请重新登录后继续。"],
  [403, "read_only", "当前账号只有读取权限。"],
  [403, "revisions_read_only", "这个工作区未启用可写版本记录。"],
  [403, "workspace_manage_required", "这项操作需要工作区管理权限。"],
  [403, "administrator_required", "这项操作需要管理员权限。"],
  [409, "workspace_owner_protected", "工作区创建者的权限受到保护。"],
  [403, "unknown", "当前账号没有执行这项操作的权限。"],
  [404, "not_found", "内容已删除或不在当前账号的访问范围内。"],
] as const)("returns safe feedback for %i %s", (status, code, expected) => {
  expect(aiAccessMessage(new ApiError(status, code, "private workspace name"))).toBe(expected);
});

test("other request failures retain the caller's specific feedback", () => {
  expect(aiAccessMessage(new ApiError(409, "conflict", "Conflict"))).toBeUndefined();
  expect(aiAccessMessage(new TypeError("network error"))).toBeUndefined();
});
