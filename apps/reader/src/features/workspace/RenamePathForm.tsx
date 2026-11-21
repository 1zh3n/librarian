import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Form, Field } from "../../ui/Forms";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { useRenamePath } from "./useRenamePath";
import styles from "./Management.module.css";

export function RenamePathForm({ workspace }: { workspace: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rename = useRenamePath(workspace);
  const ready = from.trim() && to.trim() && from.trim() !== to.trim();

  return (
    <Form
      aria-label="移动或重命名"
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !rename.isPending)
          rename.mutate(
            { from: from.trim(), to: to.trim() },
            {
              onSuccess: () => {
                setFrom("");
                setTo("");
              },
            },
          );
      }}
    >
      <p className={styles.status}>
        例如，将「草稿/周报.md」改为「归档/周报.md」。也可以填写目录路径移动整个目录。
      </p>
      <div className={styles.fields}>
        <Field label="原路径" value={from} onChange={setFrom} required />
        <Field label="新路径" value={to} onChange={setTo} required />
      </div>
      {rename.isSuccess && (
        <Feedback tone="success" className={styles.status}>
          文件或目录已更新
        </Feedback>
      )}
      {rename.isError && (
        <Feedback tone="error" className={styles.status}>
          {rename.error instanceof ApiError && rename.error.status === 409
            ? "目标路径已存在，或原路径已更改。"
            : "无法更新，请检查空间内的原路径和目标路径。"}
        </Feedback>
      )}
      <Button
        className={styles.primary}
        type="submit"
        loading={rename.isPending}
        isDisabled={!ready}
      >
        {rename.isPending ? "正在更新…" : "保存路径"}
      </Button>
    </Form>
  );
}
