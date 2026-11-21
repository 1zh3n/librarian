import { Dialog } from "../../ui/Dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { workspaceKeys } from "../../api/queries";
import type { DocumentSnapshot } from "../../api/client";
import { Button } from "../../ui/Button";
import { Field, Form } from "../../ui/Forms";
import { Feedback } from "../../ui/Feedback";
import styles from "./CreateDocumentDialog.module.css";

export function CreateDocumentDialog({
  workspace,
  folder,
  canCreate,
  close,
  created,
}: {
  workspace: string;
  folder: string;
  canCreate: boolean;
  close: () => void;
  created: (document: DocumentSnapshot) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState(folder);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.focus(), []);
  const filename = name.trim().replace(/\.md$/iu, "");
  const invalidName = /[/\\]|^\.+$/u.test(filename);
  const create = useMutation({
    mutationFn: () => {
      const parent = directory.trim().replace(/\/+$/u, "");
      const path = parent ? `${parent}/${filename}.md` : `${filename}.md`;
      return api.createDocument(workspace, { path, markdown: "", baseRevision: null });
    },
    onSuccess: created,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 403) {
        void queryClient.invalidateQueries({ queryKey: workspaceKeys.all, exact: true });
      }
    },
  });
  const error = create.error;
  const canSubmit = canCreate && Boolean(filename) && !invalidName && !create.isPending;
  let message = "";
  if (!canCreate || (error instanceof ApiError && error.status === 403)) {
    message = "写入权限已变更，请联系空间管理员恢复权限后重试。";
  } else if (invalidName) {
    message = "请在名称中使用文件名，在下方填写目录。";
  } else if (error instanceof ApiError && error.status === 409) {
    message = "该目录已有同名文档，请更换名称。";
  } else if (error) {
    message = "无法创建文档，请核对目录和权限后重试。";
  }

  return (
    <Dialog title="新建文档" busy={create.isPending} onClose={close} classes={styles}>
      <Form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <Field
          label="文档名称"
          ref={nameField}
          className={styles.field}
          value={name}
          onChange={setName}
          readOnly={create.isPending}
          required
        />
        <Field
          label="目录（可选）"
          className={styles.field}
          value={directory}
          onChange={setDirectory}
          readOnly={create.isPending}
          placeholder="例如 研究/样本"
        />
        {message && (
          <Feedback className={styles.error} tone="error">
            {message}
          </Feedback>
        )}
        <div className={styles.actions}>
          <Button isDisabled={create.isPending} onPress={close}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={!canSubmit}
            loading={create.isPending}
          >
            {create.isPending ? "正在创建…" : "创建文档"}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
