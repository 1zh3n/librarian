import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api/client";
import type { AuditFilters } from "../../api/client";
import { workspacesQuery } from "../../api/queries";
import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Field, Form, Select } from "../../ui/Forms";
import styles from "../workspace/Management.module.css";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

const resultChoices = [
  { value: "", label: "全部结果" },
  { value: "ok", label: "允许" },
  { value: "denied", label: "拒绝" },
];

export function AuditLog() {
  const workspaces = useQuery(workspacesQuery);
  const [workspaceId, setWorkspaceId] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [applied, setApplied] = useState<AuditFilters>({ limit: 100 });
  const audit = useQuery({
    queryKey: ["audit", applied],
    queryFn: ({ signal }) => api.listAudit(applied, signal),
  });

  const workspaceChoices = [
    { value: "", label: "全部空间" },
    ...(workspaces.data?.map((workspace) => ({
      value: workspace.id,
      label: workspace.name,
    })) ?? []),
  ];
  const workspaceNames = new Map(
    workspaces.data?.map((workspace) => [workspace.id, workspace.name]) ?? [],
  );

  function apply() {
    setApplied({
      ...(workspaceId ? { workspaceId } : {}),
      ...(actor.trim() ? { actor: actor.trim() } : {}),
      ...(action.trim() ? { action: action.trim() } : {}),
      ...(result ? { result: result as "ok" | "denied" } : {}),
      limit: 100,
    });
  }

  function reset() {
    setWorkspaceId("");
    setActor("");
    setAction("");
    setResult("");
    setApplied({ limit: 100 });
  }

  function exportCsv() {
    window.location.assign(api.auditCsvUrl(applied));
  }

  return (
    <section aria-label="审计日志" className={styles.section}>
      <h2>审计日志</h2>
      <p className={styles.status}>按空间、主体、动作和结果查询最近 90 天的管理操作。</p>
      <Form
        aria-label="筛选审计日志"
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <div className={styles.fields}>
          <Select
            className={styles.field}
            label="空间"
            value={workspaceId}
            entries={workspaceChoices}
            onChange={setWorkspaceId}
          />
          <Field
            className={styles.field}
            inputClassName={styles.input}
            label="主体用户名"
            value={actor}
            onChange={setActor}
          />
          <Field
            className={styles.field}
            inputClassName={styles.input}
            label="动作"
            value={action}
            onChange={setAction}
            placeholder="workspace.security_level.change"
          />
          <Select
            className={styles.field}
            label="结果"
            value={result}
            entries={resultChoices}
            onChange={setResult}
          />
        </div>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" className={styles.formAction}>
            查询
          </Button>
          <Button type="button" onPress={reset}>
            重置
          </Button>
          <Button type="button" onPress={exportCsv}>
            导出 CSV
          </Button>
        </div>
      </Form>
      {audit.isPending && <Feedback className={styles.status}>正在读取审计日志…</Feedback>}
      {audit.isError && (
        <Feedback tone="error" className={styles.status}>
          无法读取审计日志。
        </Feedback>
      )}
      {audit.data && audit.data.events.length === 0 && (
        <p className={styles.empty}>没有匹配的审计记录。</p>
      )}
      {audit.data && audit.data.events.length > 0 && (
        <ul aria-label="审计记录" className={styles.records}>
          {audit.data.events.map((event) => (
            <li key={event.id}>
              <strong>{dateFormat.format(new Date(event.at * 1000))}</strong>
              <span>
                {event.actor ?? "系统"} ·{" "}
                {event.workspaceId
                  ? (workspaceNames.get(event.workspaceId) ?? event.workspaceId)
                  : "全局"}
              </span>
              <span>
                <code>{event.action}</code>
                {event.target ? ` · ${event.target}` : ""}
              </span>
              <span>
                {event.result === "ok" ? "允许" : "拒绝"}
                {event.ruleId ? ` · ${event.ruleId}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {audit.data?.nextBefore && (
        <p className={styles.status}>只显示最近 100 条，缩小筛选范围可查看更早记录。</p>
      )}
    </section>
  );
}
