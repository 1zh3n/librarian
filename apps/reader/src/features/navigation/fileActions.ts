import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, type FileActionPreview, type Workspace } from "../../api/client";
import { workspaceKeys } from "../../api/queries";

export type DirectorySource = {
  workspace: Workspace;
  path: string;
  kind: "folder" | "document";
  documentId?: string;
  folderId?: string;
};
export type DirectoryCommand = "move" | "copy" | "delete" | "renameFolder";

export function foldersQuery(workspace: string) {
  return queryOptions({
    queryKey: [...workspaceKeys.workspace(workspace), "folders"],
    queryFn: ({ signal }) => api.folders(workspace, signal),
  });
}

export function canReceiveFiles(space: Workspace) {
  return space.canWrite && space.revisionMode === "managed";
}

export function parentPath(path: string) {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

export function joinPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export function validFolderName(name: string) {
  return Boolean(name.trim()) && !/[/\\:]|^\./iu.test(name.trim());
}

export function actionError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "操作权限已更改，请选择有写权限的位置或联系空间管理员。";
    if (error.code === "path_exists")
      return "该位置已有同名文件或文件夹，请更换名称或选择其他目录。";
    if (error.code === "file_action_recovery_conflict")
      return "恢复时文件已变化，已保留后续修改。请重新查看目录。";
    if (error.code === "file_action_changed")
      return "文件或成员权限已更改，请核对更新后的信息再提交。";
    if (error.status === 404 || error.code === "rename_source_changed")
      return "所选位置或原文件已更改，请重新选择。";
    if (error.status === 409) return "原文件或目标位置已更改，请检查是否同名或已移动。";
    if (error.status === 413) return "选中的文件过多或体积过大，请分批整理。";
    if (error.status === 422 || error.status === 400 || error.code === "invalid_request")
      return "此名称或位置不可用，请更换名称或选择其他目录。";
  }
  return "操作未能完成，请检查连接后重试。";
}

export function accessMessage(action: "copy" | "move", access: FileActionPreview["access"]) {
  const { gainedRead, gainedWrite, lost, upgraded, downgraded } = access;
  const changes = [
    gainedRead && `${gainedRead} 位成员将获得阅读权限`,
    gainedWrite && `${gainedWrite} 位成员将获得读写权限`,
    lost &&
      (action === "copy" ? `${lost} 位原成员将无法访问副本` : `${lost} 位原成员将失去访问权限`),
    upgraded && `${upgraded} 位成员从只读变为可写`,
    downgraded && `${downgraded} 位成员从可写变为只读`,
  ].filter(Boolean);
  if (!changes.length) return undefined;
  return action === "copy"
    ? `复制后，${changes.join("，")}。原件权限不变。`
    : `移动后，${changes.join("，")}。`;
}
