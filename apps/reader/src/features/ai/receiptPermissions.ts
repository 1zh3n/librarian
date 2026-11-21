import type { AiOperation, Workspace } from "../../api/client";
import { canReceiveFiles } from "../navigation/fileActions";

export function canChangeGlobalReceipt(
  operation: Pick<AiOperation, "confirmation" | "targetWorkspaceId">,
  workspaces: readonly Workspace[],
) {
  const transfer = operation.confirmation?.transfer;
  const targetId = transfer?.targetWorkspaceId ?? operation.targetWorkspaceId;
  const target = workspaces.find((space) => space.id === targetId);
  if (!target || !canReceiveFiles(target)) return false;
  if (!transfer) return true;
  const source = workspaces.find((space) => space.id === transfer.sourceWorkspaceId);
  return Boolean(
    source && (transfer.kind === "copy" || (source.canManage && canReceiveFiles(source))),
  );
}
