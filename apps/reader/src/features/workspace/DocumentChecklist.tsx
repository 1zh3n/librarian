import { Feedback } from "../../ui/Feedback";
import { Field, Checkbox } from "../../ui/Forms";
import { useState } from "react";
import type { DocumentSummary } from "../../api/client";
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
  const [query, setQuery] = useState("");
  const searchable = documents.length > 5;
  const term = searchable ? query.trim().toLocaleLowerCase() : "";
  const matches = documents.filter(
    ({ path, title }) =>
      path.toLocaleLowerCase().includes(term) || title.toLocaleLowerCase().includes(term),
  );
  const count = documents.filter(({ id }) => selected.includes(id)).length;
  return (
    <fieldset className={styles.fieldset}>
      <legend>文档范围</legend>
      {searchable && (
        <div className={styles.scopeFilter}>
          <Field
            label="筛选文档"
            value={query}
            onChange={setQuery}
            className={styles.field}
            inputClassName={styles.input}
            placeholder="输入标题或路径"
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          <Feedback>已选 {count} 篇</Feedback>
        </div>
      )}
      {!matches.length && <p className={styles.status}>没有匹配的文档</p>}
      <div className={styles.checklist}>
        {matches.map(({ id, path }) => (
          <Checkbox
            key={id}
            className={styles.checkbox}
            checked={selected.includes(id)}
            onChange={(checked) =>
              onChange(checked ? [...selected, id] : selected.filter((item) => item !== id))
            }
          >
            <span>{path}</span>
          </Checkbox>
        ))}
      </div>
    </fieldset>
  );
}
