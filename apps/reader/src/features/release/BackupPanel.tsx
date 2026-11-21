import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { BackupJob, BackupSettings, SaveBackupSettings } from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Choice } from "../workspace/ManagementFields";
import styles from "../workspace/Management.module.css";

const modes = [
  { value: "grouped", label: "按批聚合" },
  { value: "each-operation", label: "逐操作" },
] as const;

function unfinished(job: BackupJob | null | undefined) {
  return job?.status === "queued";
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
    onError: () => {
      setEdited(undefined);
      void client.invalidateQueries({ queryKey: key, exact: true });
    },
  });
  const start = useMutation({
    mutationFn: (id: string) => api.startBackup(workspace, id),
    onSuccess: (job) => {
      if (job.status === "succeeded") operation.current = undefined;
      client.setQueryData<BackupSettings>(
        key,
        (current) => current && { ...current, lastJob: job },
      );
      void client.invalidateQueries({ queryKey: key, exact: true });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: key, exact: true });
    },
  });
  const recent = targetId === saved?.targetId ? saved?.lastJob : undefined;
  const job = useQuery({
    queryKey: [...key, "job", recent?.id],
    queryFn: ({ signal }) => api.getBackupJob(workspace, recent?.id ?? "", signal),
    enabled: unfinished(recent),
    refetchInterval: (query) =>
      query.state.status !== "error" && unfinished(query.state.data ?? recent) ? 650 : false,
  });
  const latest = unfinished(recent) ? (job.data ?? recent) : recent;
  const retryId = latest?.status === "succeeded" ? undefined : latest?.id;
  const choices = [
    { value: "", label: "请选择备份目标" },
    ...(saved?.targets.map(({ id, label }) => ({ value: id, label })) ?? []),
  ];
  const startReady = Boolean(targetId && !dirty && !settings.isPending);
  const target = saved?.targets.find((item) => item.id === targetId);
  const hasTargets = Boolean(saved?.targets.length);
  const github = target
    ? target.kind === "github"
    : !hasTargets || saved?.targets.some((item) => item.kind === "github");
  const heading = github ? "GitHub 备份" : "Git 备份";
  const targetChanged =
    start.error instanceof ApiError &&
    ["backup_target_changed", "backup_target_required"].includes(start.error.code);

  return (
    <section aria-label={heading} className={styles.section}>
      <h3>{heading}</h3>
      {config.isPending && <output className={styles.status}>正在读取备份设置…</output>}
      {config.isError && (
        <p role="alert" className={styles.status}>
          无法读取备份设置。
        </p>
      )}
      {saved && !hasTargets && (
        <p className={styles.empty}>
          尚未配置备份目标。请部署者在服务数据目录的 <code>.librarian/backup-targets.json</code>{" "}
          配置目标。
        </p>
      )}
      {saved && (saved.targetNeedsSelection || targetChanged) && (
        <p role="alert" className={styles.status}>
          已选备份目标发生变更，请重新选择并保存。
        </p>
      )}
      {saved && hasTargets && (
        <Form
          aria-label="备份设置"
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!settings.isPending) {
              start.reset();
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
          {!target && !saved.targetNeedsSelection && (
            <p className={styles.status}>备份目标已配置，请选择目标并保存。</p>
          )}
          {target && (
            <div className={styles.result}>
              {target.repositoryLabel && (
                <div>
                  仓库 <code>{target.repositoryLabel}</code>
                </div>
              )}
              <div>
                分支 <code>{target.branch}</code>
              </div>
            </div>
          )}
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
              {settings.isPending ? "正在保存…" : "保存备份设置"}
            </Button>
            <Button
              className={styles.primary}
              isDisabled={!startReady || start.isPending || targetChanged}
              onPress={() => {
                if (latest?.status === "succeeded" && latest.id === operation.current) {
                  operation.current = undefined;
                }
                start.mutate(retryId ?? (operation.current ??= operationId()));
              }}
            >
              {latest?.status === "failed" ? "重试备份" : retryId ? "继续备份" : "立即备份"}
            </Button>
          </div>
        </Form>
      )}
      {saved?.targetId && !dirty && !latest && !start.isPending && !start.isError && (
        <p className={styles.empty}>已选择目标，尚未备份。</p>
      )}
      {start.isPending && <output className={styles.status}>正在备份…</output>}
      {!start.isPending && unfinished(latest) && (
        <output className={styles.status}>备份待续</output>
      )}
      {!start.isPending && latest?.status === "succeeded" && (
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
      {!start.isPending && latest?.status === "failed" && (
        <p role="alert" className={styles.status}>
          备份失败，请重试。{latest.message && ` ${latest.message}`}
        </p>
      )}
      {start.isError && !targetChanged && (
        <p role="alert" className={styles.status}>
          无法开始备份，请重试。
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
