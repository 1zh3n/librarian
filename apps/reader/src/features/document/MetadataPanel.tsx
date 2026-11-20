import { useState } from "react";
import { Button, Form, Input, Label, TextField } from "../../ui/primitives";
import type { EditorSession } from "../../editor/codemirror/adapter";
import { metadataEdits, readMetadata } from "./metadata";
import styles from "./DocumentPage.module.css";

export function MetadataPanel({
  editor,
  onApply,
  openSource,
}: {
  editor: EditorSession;
  onApply: () => void;
  openSource: () => void;
}) {
  const [initial] = useState(() => readMetadata(editor.source()));
  const [failure, setFailure] = useState("");

  if (initial.invalid) {
    return (
      <div className={styles.metadata}>
        <p>Front Matter 无法解析</p>
        <Button className={styles.actionButton} onPress={openSource}>
          打开完整源码
        </Button>
      </div>
    );
  }
  return (
    <Form
      className={styles.metadata}
      aria-label="文档属性"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const value = (key: string) => {
          const field = data.get(key);
          return typeof field === "string" ? field : "";
        };
        try {
          setFailure("");
          const title = value("title");
          const series = value("series");
          const status = value("status");
          const changes = metadataEdits(editor.source(), {
            ...(title !== initial.title && { title }),
            ...(series !== initial.series && { series }),
            ...(status !== initial.status && { status }),
            addTag: value("addTag"),
          });
          editor.applyChanges(changes);
          onApply();
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "无法更新文档属性");
        }
      }}
    >
      <TextField name="title" defaultValue={initial.title} className={styles.metadataField}>
        <Label>标题</Label>
        <Input />
      </TextField>
      <TextField name="series" defaultValue={initial.series} className={styles.metadataField}>
        <Label>系列</Label>
        <Input />
      </TextField>
      <TextField name="status" defaultValue={initial.status} className={styles.metadataField}>
        <Label>状态</Label>
        <Input />
      </TextField>
      {initial.tags.length > 0 && (
        <ul aria-label="现有标签" className={styles.tags}>
          {initial.tags.map((tag, i) => (
            <li key={`${i}:${tag}`}>{tag}</li>
          ))}
        </ul>
      )}
      <TextField name="addTag" className={styles.metadataField}>
        <Label>添加标签</Label>
        <Input />
      </TextField>
      {failure && <p role="alert">{failure}</p>}
      <Button type="submit" className={styles.actionButton}>
        保存属性
      </Button>
    </Form>
  );
}
