import type { DocumentSummary } from "../../api/client";
import { Checkbox } from "../../ui/primitives";
import styles from "./Management.module.css";

export function DocumentChecklist({
  documents,
  selected,
  onChange,
}: {
  documents: readonly DocumentSummary[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>文档范围</legend>
      <div className={styles.checklist}>
        {documents.map(({ id, path }) => (
          <Checkbox
            key={id}
            className={styles.checkbox}
            isSelected={selected.includes(id)}
            onChange={(checked) =>
              onChange(checked ? [...selected, id] : selected.filter((item) => item !== id))
            }
          >
            <span className={styles.checkboxMark} aria-hidden="true" />
            <span>{path}</span>
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
}
