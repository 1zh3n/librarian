import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { Field, Form } from "../../ui/Forms";
import { actionError, foldersQuery, joinPath, validFolderName } from "./fileActions";
import styles from "../document/CreateDocumentDialog.module.css";

export function CreateFolderForm({
  workspace,
  parent,
  created,
  close,
  dialog = false,
}: {
  workspace: string;
  parent: string;
  created: (path: string) => void;
  close: () => void;
  dialog?: boolean;
}) {
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: (path: string) => api.createFolder(workspace, path),
    onSuccess: async ({ path }) => {
      await client.invalidateQueries({ queryKey: foldersQuery(workspace).queryKey });
      created(path);
    },
  });
  const valid = validFolderName(name);
  const form = (
    <Form
      className={styles.form}
      onKeyDown={(event) => {
        if (
          !dialog &&
          event.key === "Escape" &&
          !event.nativeEvent.isComposing &&
          !create.isPending
        ) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !create.isPending) create.mutate(joinPath(parent, name.trim()));
      }}
    >
      {dialog && <p className={styles.location}>所在目录　{parent || "根目录"}</p>}
      <Field
        label="文件夹名称"
        ref={field}
        required
        value={name}
        onChange={(value) => {
          setName(value);
          create.reset();
        }}
        readOnly={create.isPending}
      />
      {((name.trim() && !valid) || create.isError) && (
        <Feedback className={styles.error} tone="error">
          {create.isError ? actionError(create.error) : "请输入有效的文件夹名称。"}
        </Feedback>
      )}
      <div className={styles.actions}>
        <Button variant="outline" isDisabled={create.isPending} onPress={close}>
          {dialog ? "取消" : "取消新建"}
        </Button>
        <Button variant="primary" type="submit" isDisabled={!valid} loading={create.isPending}>
          {create.isPending ? "正在创建…" : "创建文件夹"}
        </Button>
      </div>
    </Form>
  );
  return dialog ? (
    <Dialog classes={styles} title="新建文件夹" onClose={close} busy={create.isPending}>
      {form}
    </Dialog>
  ) : (
    form
  );
}
