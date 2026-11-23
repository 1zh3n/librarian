import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Feedback } from "../../ui/Feedback";
import { Select } from "../../ui/Forms";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Workspace } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { securityLevelLabel, securityLevels } from "./securityLabels";
import styles from "./Management.module.css";

type Level = Workspace["securityLevel"];

const rank: Record<Level, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

const descriptions: Record<Level, string> = {
  public: "内容可以发布到公网；仍然会扫描高置信凭证。",
  internal: "团队日常文档；外部 AI/MCP 发送前会扫描高置信凭证。",
  confidential: "外部 AI/MCP、匿名分享、发布和离线默认关闭。",
  secret: "禁止所有外部出口；建议放在独立实例或独立数据根。",
};

function capabilityRows(workspace: Workspace) {
  const secret = workspace.securityLevel === "secret";
  const restricted = workspace.securityLevel === "confidential";
  return [
    {
      name: "外部 AI",
      allowed: workspace.capabilities.externalAi,
      text: workspace.capabilities.externalAi ? "允许，发送前扫描" : "关闭",
    },
    {
      name: "外部 MCP",
      allowed: workspace.capabilities.externalMcp,
      text: workspace.capabilities.externalMcp ? "允许，结果扫描" : "关闭",
    },
    {
      name: "匿名分享",
      allowed: workspace.capabilities.anonymousShare,
      text: workspace.capabilities.anonymousShare ? "固定版本 + 到期" : "关闭",
    },
    {
      name: "公开发布",
      allowed: workspace.capabilities.publication,
      text: workspace.capabilities.publication ? "允许" : "关闭",
    },
    {
      name: "离线副本",
      allowed: workspace.capabilities.offline,
      text: workspace.capabilities.offline ? "允许" : "关闭",
    },
    {
      name: "远端 Git 备份",
      allowed: workspace.capabilities.remoteBackup,
      text: secret ? "关闭" : restricted ? "仅加密目标" : "允许",
    },
  ];
}

export function WorkspaceSecurity({ workspace }: { workspace: Workspace }) {
  const client = useQueryClient();
  const [current, setCurrent] = useState(workspace);
  const [level, setLevel] = useState<Level>(workspace.securityLevel);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const lowering = rank[level] < rank[current.securityLevel];
  const dirty = level !== current.securityLevel;
  const save = useMutation({
    mutationFn: (confirmed: boolean) =>
      api.updateWorkspace(workspace.id, {
        securityLevel: level,
        ...(lowering && confirmed && { confirmSecurityDowngrade: true }),
      }),
    onSuccess: (next) => {
      client.setQueryData<Workspace[]>(workspaceKeys.all, (list) =>
        list?.map((item) => (item.id === next.id ? next : item)),
      );
      setCurrent(next);
      setLevel(next.securityLevel);
      setConfirming(false);
      setSaved(true);
    },
  });
  const rows = capabilityRows(current);

  function submit() {
    if (!dirty) return;
    if (lowering) {
      setConfirming(true);
      return;
    }
    save.mutate(false);
  }

  return (
    <div className={styles.security}>
      <div className={styles.securitySummary}>
        <span className={styles.securityBadge} data-level={current.securityLevel}>
          {securityLevelLabel(current.securityLevel)}
        </span>
        <p className={styles.securityNote}>{descriptions[current.securityLevel]}</p>
      </div>
      <dl className={styles.capabilities}>
        {rows.map((row) => (
          <div key={row.name} className={styles.capability}>
            <dt>{row.name}</dt>
            <dd data-allowed={row.allowed}>{row.text}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.securityForm}>
        <Select
          label="安全等级"
          value={level}
          entries={securityLevels}
          onChange={(value) => {
            setLevel(value);
            setSaved(false);
          }}
          disabled={save.isPending}
        />
        <Button
          variant="primary"
          className={styles.formAction}
          loading={save.isPending}
          isDisabled={!dirty || save.isPending}
          onPress={submit}
        >
          {save.isPending ? "正在保存…" : "保存安全等级"}
        </Button>
      </div>
      {dirty && (
        <Feedback tone="status" className={styles.status}>
          {lowering
            ? `改为「${securityLevelLabel(level)}」会重新开放部分外部出口，保存前需要确认。`
            : `改为「${securityLevelLabel(level)}」会立即收紧外部出口。`}
        </Feedback>
      )}
      {save.isError && !confirming && (
        <Feedback tone="error" className={styles.status}>
          {save.error instanceof ApiError && save.error.status === 409
            ? "空间等级发生冲突，请刷新后重试。"
            : "无法保存安全等级。"}
        </Feedback>
      )}
      {saved && !dirty && !confirming && (
        <Feedback tone="success" className={styles.status}>
          安全等级已保存
        </Feedback>
      )}
      {confirming && (
        <ConfirmDialog
          title="降低安全等级？"
          confirmLabel="降低等级"
          destructive
          busy={save.isPending}
          error={save.isError ? "无法保存安全等级。" : undefined}
          onConfirm={() => save.mutate(true)}
          onCancel={() => {
            setConfirming(false);
            save.reset();
          }}
        >
          从「{securityLevelLabel(current.securityLevel)}」改为「{securityLevelLabel(level)}
          」会重新允许部分外部出口， 已有的文档不会被改写，但之后的外部
          AI、MCP、分享或离线副本可能读取到这些内容。
        </ConfirmDialog>
      )}
    </div>
  );
}
