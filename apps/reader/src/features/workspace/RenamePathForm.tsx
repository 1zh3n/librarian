import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Field } from "./ManagementFields";
import styles from "./Management.module.css";

function operationId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function RenamePathForm({ workspace }: { workspace: string }) {
  const client = useQueryClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const previous = useRef<{ operationId: string; from: string; to: string } | undefined>(undefined);
  const rename = useMutation({
    mutationFn: () => {
      const input = { from: from.trim(), to: to.trim() };
      const last = previous.current;
      const request =
        last?.from === input.from && last.to === input.to
          ? last
          : { ...input, operationId: operationId() };
      previous.current = request;
      return api.renameWorkspacePath(workspace, request);
    },
    onSuccess: async () => {
      previous.current = undefined;
      setFrom("");
      setTo("");
      await client.invalidateQueries({ queryKey: workspaceKeys.workspace(workspace) });
    },
  });
  const ready = from.trim() && to.trim() && from.trim() !== to.trim();

  return (
    <Form
      aria-label="重命名路径"
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !rename.isPending) rename.mutate();
      }}
    >
      <div className={styles.fields}>
        <Field label="原路径" value={from} onChange={setFrom} required />
        <Field label="新路径" value={to} onChange={setTo} required />
      </div>
      {rename.isSuccess && <output className={styles.status}>路径已更新</output>}
      {rename.isError && (
        <p className={styles.status} role="alert">
          {rename.error instanceof ApiError && rename.error.status === 409
            ? "目标路径已存在，或原路径已更改。"
            : "无法重命名，请检查空间内的路径。"}
        </p>
      )}
      <Button className={styles.primary} type="submit" isDisabled={!ready || rename.isPending}>
        重命名
      </Button>
    </Form>
  );
}
