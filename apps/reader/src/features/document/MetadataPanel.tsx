import { Button } from "../../ui/Button";
import { Feedback } from "../../ui/Feedback";
import { Form, Field } from "../../ui/Forms";
import { useState } from "react";
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
      <Field
        label="标题"
        name="title"
        defaultValue={initial.title}
        className={styles.metadataField}
      />
      <Field
        label="系列"
        name="series"
        defaultValue={initial.series}
        className={styles.metadataField}
      />
      <Field
        label="状态"
        name="status"
        defaultValue={initial.status}
        className={styles.metadataField}
      />
      {initial.tags.length > 0 && (
        <ul aria-label="现有标签" className={styles.tags}>
          {initial.tags.map((tag, i) => (
            <li key={`${i}:${tag}`}>{tag}</li>
          ))}
        </ul>
      )}
      <Field label="添加标签" name="addTag" className={styles.metadataField} />
      {failure && <Feedback tone="error">{failure}</Feedback>}
      <Button type="submit" className={styles.actionButton}>
        保存属性
      </Button>
    </Form>
  );
}
