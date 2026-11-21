import { useEffect, useRef, useState } from "react";
import { ApiError, type DocumentSummary } from "../../api/client";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { Field, Form } from "../../ui/Forms";
import { useRenamePath } from "../workspace/useRenamePath";
import styles from "./CreateDocumentDialog.module.css";

export function RenameDocumentDialog({
  document,
  allowed,
  close,
}: {
  document: DocumentSummary;
  allowed: boolean;
  close: () => void;
}) {
  const { path } = document;
  const parent = path.slice(0, path.lastIndexOf("/") + 1);
  const originalName = path.slice(parent.length, -".md".length);
  const [name, setName] = useState(originalName);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const rename = useRenamePath(document.workspaceId);
  const stem = name.trim().replace(/\.md$/iu, "");
  const invalid = /[/\\:]|^\.+$|\.outline$/u.test(stem);
  const to = parent + stem + ".md";
  const ready =
    allowed &&
    Boolean(stem) &&
    name !== originalName &&
    !invalid &&
    to !== path &&
    !rename.isPending;
  const error = rename.error;
  let message: string | undefined;
  if (!allowed || (error instanceof ApiError && error.status === 403)) {
    message = "当前没有重命名权限，请联系空间管理员。";
  } else if (invalid) {
    message = "请输入同一目录内的有效 Markdown 文件名。";
  } else if (error instanceof ApiError && error.code === "path_exists") {
    message = "该目录已有同名文件，请更换文件名。";
  } else if (error instanceof ApiError && error.code === "rename_source_changed") {
    message = "文档已移出原路径。请关闭弹窗，重新打开要重命名的文档。";
  } else if (error) {
    message = "无法重命名，请核对原路径和文件名后重试。";
  }
  return (
    <Dialog title="重命名文档" busy={rename.isPending} onClose={close} classes={styles}>
      <Form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready)
            rename.mutate(
              { from: path, to, expectedDocumentId: document.id },
              { onSuccess: close },
            );
        }}
      >
        <div>{path}</div>
        <Field
          ref={field}
          label="文件名"
          className={styles.field}
          value={name}
          readOnly={rename.isPending}
          required
          onChange={(value) => {
            if (rename.isError) rename.reset();
            setName(value);
          }}
        />
        {message && (
          <Feedback tone="error" className={styles.error}>
            {message}
          </Feedback>
        )}
        <div className={styles.actions}>
          <Button isDisabled={rename.isPending} onPress={close}>
            取消
          </Button>
          <Button variant="primary" type="submit" loading={rename.isPending} isDisabled={!ready}>
            保存文件名
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
