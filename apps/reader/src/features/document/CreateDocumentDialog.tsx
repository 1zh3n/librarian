import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { DocumentSnapshot } from "../../api/client";
import {
  Button,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "../../ui/primitives";
import styles from "./CreateDocumentDialog.module.css";

export function CreateDocumentDialog({
  workspace,
  folder,
  close,
  created,
}: {
  workspace: string;
  folder: string;
  close: () => void;
  created: (document: DocumentSnapshot) => void;
}) {
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
  });
  const error = create.error;

  return (
    <ModalOverlay
      isOpen
      isDismissable={!create.isPending}
      isKeyboardDismissDisabled={create.isPending}
      onOpenChange={(open) => !open && close()}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <Heading slot="title">新建文档</Heading>
          <Form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (filename && !invalidName && !create.isPending) create.mutate();
            }}
          >
            <TextField className={styles.field} value={name} onChange={setName} isRequired>
              <Label>文档名称</Label>
              <Input ref={nameField} />
            </TextField>
            <TextField className={styles.field} value={directory} onChange={setDirectory}>
              <Label>目录（可选）</Label>
              <Input placeholder="例如 研究/样本" />
            </TextField>
            {(invalidName || error) && (
              <p className={styles.error} role="alert">
                {invalidName
                  ? "请在名称中使用文件名，在下方填写目录。"
                  : error instanceof ApiError && error.status === 409
                    ? "该目录已有同名文档，请更换名称。"
                    : "无法创建文档，请核对目录和权限后重试。"}
              </p>
            )}
            <div className={styles.actions}>
              <Button isDisabled={create.isPending} onPress={close}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={!filename || invalidName || create.isPending}
              >
                {create.isPending ? "正在创建…" : "创建文档"}
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
