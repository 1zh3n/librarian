import { FileTrigger } from "react-aria-components";
import { Icon } from "./Icon";
import { Button } from "./Button";
import styles from "./FilePicker.module.css";

export function FilePicker({
  files,
  disabled,
  attachment = false,
  onChange,
}: {
  files: readonly File[];
  disabled: boolean;
  attachment?: boolean;
  onChange: (files: File[]) => void;
}) {
  return (
    <div className={styles.picker}>
      <FileTrigger
        allowsMultiple
        onSelect={(selection) => selection?.length && onChange(Array.from(selection))}
      >
        <Button
          type="button"
          aria-label="选择文件"
          variant={attachment ? "ghost" : "outline"}
          isDisabled={disabled}
        >
          {attachment && <Icon name="paperclip" />}
          <span>选择文件</span>
        </Button>
      </FileTrigger>
      <span className={styles.files} aria-live="polite">
        {files.length > 1 ? `已选 ${files.length} 个文件` : files[0]?.name}
      </span>
    </div>
  );
}
