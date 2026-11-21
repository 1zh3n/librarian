import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Workspace, WorkspaceSettings } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Choice, Field, formatLocalDate } from "./ManagementFields";
import styles from "./Management.module.css";

const origins = [
  { value: "native", label: "原生" },
  { value: "delivery", label: "投递" },
] as const;

const retentions = [
  { value: "persistent", label: "长期保存" },
  { value: "temporary", label: "临时保存" },
] as const;

export function WorkspaceEditor({
  current,
  onCreated,
}: {
  current?: Workspace;
  onCreated?: (workspace: Workspace) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(current?.name ?? "");
  const [origin, setOrigin] = useState<Workspace["origin"]>(current?.origin ?? "native");
  const [retention, setRetention] = useState<Workspace["retention"]>(
    current?.retention ?? "persistent",
  );
  const [expires, setExpires] = useState(formatLocalDate(current?.expiresAt));
  const [expiryError, setExpiryError] = useState(false);
  const temporary = origin === "delivery" && retention === "temporary";

  const save = useMutation({
    mutationFn: (body: WorkspaceSettings) =>
      current ? api.updateWorkspace(current.id, body) : api.createWorkspace({ ...body, origin }),
    onSuccess: async (saved) => {
      await client.cancelQueries({ queryKey: workspaceKeys.all, exact: true });
      client.setQueryData<Workspace[]>(workspaceKeys.all, (list) =>
        list?.some((workspace) => workspace.id === saved.id)
          ? list.map((workspace) => (workspace.id === saved.id ? saved : workspace))
          : [...(list ?? []), saved],
      );
      setName(saved.name);
      setExpires(formatLocalDate(saved.expiresAt));
      onCreated?.(saved);
    },
  });

  return (
    <Form
      className={styles.form}
      aria-label={current ? "空间设置" : "新建空间"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || save.isPending) return;
        const expiration = temporary ? Math.floor(new Date(expires).getTime() / 1_000) : null;
        if (expiration !== null && !(expiration > Date.now() / 1_000)) {
          setExpiryError(true);
          return;
        }
        setExpiryError(false);
        save.mutate({
          name: name.trim(),
          ...(origin === "delivery" && { retention, expiresAt: expiration }),
        });
      }}
    >
      <Field label="空间名称" value={name} onChange={setName} required />
      <div className={styles.fields}>
        {!current && (
          <Choice label="空间来源" value={origin} entries={origins} onChange={setOrigin} />
        )}
        {origin === "delivery" && (
          <Choice
            label="保留方式"
            value={retention}
            entries={retentions}
            onChange={(value) => {
              setRetention(value);
              setExpiryError(false);
            }}
          />
        )}
        {temporary && (
          <Field
            label="到期时间"
            type="datetime-local"
            value={expires}
            onChange={(value) => {
              setExpires(value);
              setExpiryError(false);
            }}
            required
          />
        )}
      </div>
      {expiryError && (
        <p role="alert" className={styles.status}>
          到期时间必须晚于现在。
        </p>
      )}
      {save.isError && (
        <p role="alert" className={styles.status}>
          {save.error instanceof ApiError && save.error.status === 409
            ? "空间设置发生冲突，请检查后重试。"
            : "无法保存空间设置。"}
        </p>
      )}
      {save.isSuccess && current && <output className={styles.status}>空间设置已保存</output>}
      <Button className={styles.primary} type="submit" isDisabled={save.isPending || !name.trim()}>
        {save.isPending ? "正在保存…" : current ? "保存空间设置" : "创建空间"}
      </Button>
    </Form>
  );
}
