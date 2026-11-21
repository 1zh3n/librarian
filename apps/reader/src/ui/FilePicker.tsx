import { FileTrigger } from "react-aria-components";
import { Button } from "./Button";
import styles from "./FilePicker.module.css";

export function FilePicker({
  files,
  disabled,
  onChange,
}: {
  files: readonly File[];
  disabled: boolean;
  onChange: (files: File[]) => void;
}) {
  return (
    <div className={styles.picker}>
      <FileTrigger
        allowsMultiple
        onSelect={(selection) => selection?.length && onChange(Array.from(selection))}
      >
        <Button type="button" variant="outline" isDisabled={disabled}>
          选择文件
        </Button>
      </FileTrigger>
      <span className={styles.files} aria-live="polite">
        {files.length > 1 ? `已选 ${files.length} 个文件` : files[0]?.name}
      </span>
    </div>
  );
}
