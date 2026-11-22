import { useState } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Feedback } from "../../ui/Feedback";
import { FilePicker } from "../../ui/FilePicker";
import { Form } from "../../ui/Forms";
import { assetsDirectory, imageValidationError } from "./imageInsert";
import styles from "./ImageInsertDialog.module.css";

export function ImageInsertDialog({
  documentPath,
  busy,
  onClose,
  onInsert,
}: {
  documentPath: string;
  busy: boolean;
  onClose: () => void;
  onInsert: (files: File[]) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const uploading = busy || pending;
  const dialogClasses = {
    overlay: styles.overlay!,
    modal: styles.modal!,
    dialog: styles.dialog!,
  };

  async function submit() {
    const invalid = imageValidationError(files);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(undefined);
    setPending(true);
    try {
      await onInsert(files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "图片上传失败，请重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog title="插入图片" busy={uploading} onClose={onClose} classes={dialogClasses}>
      <Form
        className={styles.form!}
        onSubmit={(event) => {
          event.preventDefault();
          if (!uploading) void submit();
        }}
      >
        <p className={styles.hint}>
          图片保存到 <code>{assetsDirectory(documentPath)}/</code>，插入到当前光标位置。支持
          PNG、JPEG、WebP、GIF 和 AVIF，单张最多 12 MiB。
        </p>
        <FilePicker
          files={files}
          disabled={uploading}
          onChange={(next) => {
            setFiles(next);
            setError(undefined);
          }}
        />
        {files.length > 1 && (
          <ul className={styles.files} aria-label="待插入图片">
            {files.map((file) => (
              <li key={`${file.name}-${file.size}-${file.lastModified}`}>{file.name}</li>
            ))}
          </ul>
        )}
        {error && <Feedback tone="error">{error}</Feedback>}
        <div className={styles.actions}>
          <Button type="button" onPress={onClose} isDisabled={uploading}>
            取消
          </Button>
          <Button type="submit" variant="primary" isDisabled={uploading || files.length === 0}>
            {uploading ? "正在上传…" : "插入"}
          </Button>
        </div>
      </Form>
    </Dialog>
  );
}
