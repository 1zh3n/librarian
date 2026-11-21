import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Form, Field, Select } from "../../ui/Forms";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Workspace, WorkspaceSettings } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Disclosure } from "../../ui/Disclosure";
import { formatLocalDate } from "./ManagementFields";
import styles from "./Management.module.css";

const origins = [
  { value: "native", label: "普通空间" },
  { value: "delivery", label: "外部文档接收" },
] as const;

const retentions = [
  { value: "persistent", label: "长期保存" },
  { value: "temporary", label: "临时保存" },
] as const;

function focusWorkspaceName(input: HTMLInputElement | null) {
  input?.focus();
}

function isFutureDate(value: string) {
  return new Date(value).getTime() > Date.now();
}

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
  const expiryField = useRef<HTMLInputElement>(null);
  const expiryDescription = useId();
  const [advanced, setAdvanced] = useState(false);
  const temporary = origin === "delivery" && retention === "temporary";
  const expiration = temporary
    ? current?.expiresAt != null && expires === formatLocalDate(current.expiresAt)
      ? current.expiresAt
      : Math.floor(new Date(expires).getTime() / 1_000)
    : null;
  const showExpiryError = temporary && expiryError;

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
      onCreated?.(saved);
    },
  });

  function revealInvalidExpiry() {
    setAdvanced(true);
    setExpiryError(true);
    requestAnimationFrame(() => expiryField.current?.focus());
  }

  const unchanged =
    current &&
    name.trim() === current.name &&
    (origin !== "delivery" || retention === current.retention) &&
    (!temporary || expires === formatLocalDate(current.expiresAt));
  const canSave =
    Boolean(name.trim()) && !unchanged && !save.isPending && !(current && showExpiryError);

  const retentionFields = origin === "delivery" && (
    <>
      <Select
        label="保留方式"
        value={retention}
        entries={retentions}
        onChange={(value) => {
          setRetention(value);
          setExpiryError(Boolean(current) && value === "temporary" && !isFutureDate(expires));
        }}
      />
      {temporary && (
        <Field
          label="到期时间"
          type="datetime-local"
          value={expires}
          ref={expiryField}
          onInvalid={revealInvalidExpiry}
          {...(showExpiryError && { invalid: true, "aria-describedby": expiryDescription })}
          onChange={(value) => {
            setExpires(value);
            setExpiryError(Boolean(current) && !isFutureDate(value));
          }}
          required
        />
      )}
    </>
  );

  return (
    <Form
      className={styles.form}
      aria-label={current ? "空间设置" : "新建空间"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        if (expiration !== null && !(expiration > Date.now() / 1_000)) {
          revealInvalidExpiry();
          return;
        }
        setExpiryError(false);
        save.mutate(
          {
            name: name.trim(),
            ...(origin === "delivery" && { retention, expiresAt: expiration }),
          },
          {
            onSuccess: (confirmed) => {
              setName((draft) => (draft === name ? confirmed.name : draft));
              if (temporary) {
                setExpires((draft) =>
                  draft === expires ? formatLocalDate(confirmed.expiresAt) : draft,
                );
              }
            },
          },
        );
      }}
    >
      <Field
        label="空间名称"
        value={name}
        onChange={setName}
        required
        ref={current ? null : focusWorkspaceName}
      />
      {current ? (
        retentionFields && <div className={styles.fields}>{retentionFields}</div>
      ) : (
        <Disclosure title="高级选项" expanded={advanced} onChange={setAdvanced}>
          <p className={styles.status}>
            普通空间也能接收手动上传和项目自动导入。需要让接收的文档随空间到期清理时，可选择「外部文档接收」。
          </p>
          <div className={styles.fields}>
            <Select label="空间用途" value={origin} entries={origins} onChange={setOrigin} />
            {retentionFields}
          </div>
        </Disclosure>
      )}
      {showExpiryError && (
        <Feedback id={expiryDescription} tone="error" className={styles.status}>
          {expires ? "到期时间必须晚于现在。" : "请填写到期时间。"}
        </Feedback>
      )}
      {save.isError && (
        <Feedback tone="error" className={styles.status}>
          {save.error instanceof ApiError && save.error.status === 409
            ? "空间设置发生冲突，请检查后重试。"
            : "无法保存空间设置。"}
        </Feedback>
      )}
      {save.isSuccess && unchanged && (
        <Feedback tone="success" className={styles.status}>
          空间设置已保存
        </Feedback>
      )}
      <Button
        variant="primary"
        className={styles.formAction}
        type="submit"
        loading={save.isPending}
        isDisabled={!canSave}
      >
        {save.isPending ? "正在保存…" : current ? "保存空间设置" : "创建空间"}
      </Button>
    </Form>
  );
}
