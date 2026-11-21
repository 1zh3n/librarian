import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { BackupJob, SaveBackupSettings } from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Choice } from "../workspace/ManagementFields";
import styles from "../workspace/Management.module.css";

const modes = [
  { value: "grouped", label: "按批聚合" },
  { value: "each-operation", label: "逐操作" },
] as const;

function running(job: BackupJob | null | undefined) {
  return Boolean(job && job.status !== "succeeded" && job.status !== "failed");
}

export function BackupPanel({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const key = [...workspaceKeys.workspace(workspace), "backup"];
  const config = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.getBackup(workspace, signal),
  });
  const [edited, setEdited] = useState<SaveBackupSettings>();
  const operation = useRef<string | undefined>(undefined);
  const saved = config.data;
  const targetId = edited?.targetId ?? (edited ? null : (saved?.targetId ?? null));
  const mode = edited?.mode ?? saved?.mode ?? "grouped";
  const dirty = Boolean(saved && (targetId !== saved.targetId || mode !== saved.mode));

  const settings = useMutation({
    mutationFn: (body: SaveBackupSettings) => api.saveBackup(workspace, body),
    onSuccess: (result) => {
      client.setQueryData(key, result);
      setEdited(undefined);
      operation.current = undefined;
    },
  });
  const start = useMutation({
    mutationFn: (id: string) => api.startBackup(workspace, id),
    onSuccess: (job) => {
      if (job.status === "succeeded") operation.current = undefined;
      void client.invalidateQueries({ queryKey: key, exact: true });
    },
  });
  const recent = start.data ?? saved?.lastJob;
  const job = useQuery({
    queryKey: [...key, "job", recent?.id],
    queryFn: ({ signal }) => api.getBackupJob(workspace, recent?.id ?? "", signal),
    enabled: running(recent),
    refetchInterval: (query) =>
      query.state.status !== "error" && running(query.state.data ?? recent) ? 650 : false,
  });
  const latest = running(recent) ? (job.data ?? recent) : recent;
  const retryId = latest?.status === "succeeded" ? undefined : latest?.id;
  const choices = [
    { value: "", label: "停用备份" },
    ...(saved?.targets.map(({ id, label }) => ({ value: id, label })) ?? []),
  ];
  const startReady = Boolean(targetId && !dirty && !settings.isPending);

  return (
    <section aria-label="工作区备份" className={styles.section}>
      <h2>工作区备份</h2>
      {config.isError && (
        <p role="alert" className={styles.status}>
          无法读取备份设置。
        </p>
      )}
      {saved && saved.targets.length === 0 && (
        <p className={styles.status}>部署尚未配置备份目标。</p>
      )}
      {saved && saved.targets.length > 0 && (
        <Form
          aria-label="备份设置"
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!settings.isPending) {
              if (start.data) start.reset();
              settings.mutate({ targetId, mode });
            }
          }}
        >
          <div className={styles.fields}>
            <Choice
              label="备份目标"
              value={targetId ?? ""}
              entries={choices}
              onChange={(next) => setEdited({ targetId: next || null, mode })}
            />
            <Choice
              label="备份粒度"
              value={mode}
              entries={modes}
              onChange={(next) => setEdited({ targetId, mode: next })}
            />
          </div>
          {settings.isSuccess && !dirty && (
            <output className={styles.status}>备份设置已保存</output>
          )}
          {settings.isError && (
            <p role="alert" className={styles.status}>
              无法保存备份设置。
            </p>
          )}
          <div className={styles.actions}>
            <Button
              className={styles.secondary}
              type="submit"
              isDisabled={settings.isPending || start.isPending}
            >
              保存备份设置
            </Button>
            <Button
              className={styles.primary}
              isDisabled={!startReady || start.isPending}
              onPress={() => start.mutate(retryId ?? (operation.current ??= operationId()))}
            >
              {latest?.status === "failed" ? "重试备份" : retryId ? "继续备份" : "立即备份"}
            </Button>
          </div>
        </Form>
      )}
      {start.isPending && <output className={styles.status}>正在备份…</output>}
      {!start.isPending && running(latest) && <output className={styles.status}>备份待完成</output>}
      {latest?.status === "succeeded" && (
        <div className={styles.result}>
          <output>备份已完成</output>
          {latest.sourceCommitId && (
            <div>
              来源版本 <code>{latest.sourceCommitId}</code>
            </div>
          )}
          {latest.commitId && (
            <div>
              备份版本 <code>{latest.commitId}</code>
            </div>
          )}
        </div>
      )}
      {latest?.status === "failed" && (
        <p role="alert" className={styles.status}>
          {latest.message || "备份失败，请重试。"}
        </p>
      )}
      {start.isError && (
        <p role="alert" className={styles.status}>
          {start.error instanceof ApiError && start.error.code === "backup_target_changed"
            ? "备份目标配置已更新，请重新保存设置后重试。"
            : "无法开始备份，请重试。"}
        </p>
      )}
      {job.isError && (
        <p role="alert" className={styles.status}>
          无法读取备份状态。
        </p>
      )}
    </section>
  );
}
