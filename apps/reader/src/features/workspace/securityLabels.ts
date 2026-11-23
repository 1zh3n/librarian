import type { Workspace } from "../../api/client";

export const securityLevels = [
  { value: "public", label: "公开" },
  { value: "internal", label: "内部" },
  { value: "confidential", label: "受限" },
  { value: "secret", label: "高敏" },
] as const;

export function securityLevelLabel(level: Workspace["securityLevel"]) {
  return securityLevels.find((entry) => entry.value === level)?.label ?? level;
}
