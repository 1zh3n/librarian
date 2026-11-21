import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { operationId } from "../../api/operationId";
import { workspaceKeys } from "../../api/queries";
import { Button, Form } from "../../ui/primitives";
import { Field } from "./ManagementFields";
import styles from "./Management.module.css";

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
      aria-label="移动或重命名"
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !rename.isPending) rename.mutate();
      }}
    >
      <p className={styles.status}>
        例如，将「草稿/周报.md」改为「归档/周报.md」。也可以填写目录路径移动整个目录。
      </p>
      <div className={styles.fields}>
        <Field label="原路径" value={from} onChange={setFrom} required />
        <Field label="新路径" value={to} onChange={setTo} required />
      </div>
      {rename.isSuccess && <output className={styles.status}>文件或目录已更新</output>}
      {rename.isError && (
        <p className={styles.status} role="alert">
          {rename.error instanceof ApiError && rename.error.status === 409
            ? "目标路径已存在，或原路径已更改。"
            : "无法更新，请检查空间内的原路径和目标路径。"}
        </p>
      )}
      <Button className={styles.primary} type="submit" isDisabled={!ready || rename.isPending}>
        {rename.isPending ? "正在更新…" : "保存路径"}
      </Button>
    </Form>
  );
}
