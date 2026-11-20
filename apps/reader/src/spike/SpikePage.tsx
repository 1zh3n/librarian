import { useRef, useState } from "react";
import { Button } from "react-aria-components/Button";
import styles from "./SpikePage.module.css";

const fixture = "# 河边的笔记\n\n清晨的水面很安静。";

export function SpikePage() {
  const [editing, setEditing] = useState(false);
  const body = useRef(fixture);
  const [markdown, setMarkdown] = useState(fixture);
  const [heading = "", ...paragraphs] = markdown.split("\n\n");

  function leaveEditor() {
    setMarkdown(body.current);
    setEditing(false);
  }

  return (
    <main className={styles.canvas}>
      {editing ? (
        <>
          <Button onPress={leaveEditor}>返回阅读</Button>
          <textarea
            ref={(field) => {
              field?.focus();
            }}
            className={styles.source}
            aria-label="Markdown 正文"
            defaultValue={markdown}
            onChange={(event) => {
              body.current = event.currentTarget.value;
            }}
          />
        </>
      ) : (
        <>
          <Button onPress={() => setEditing(true)}>编辑正文</Button>
          <article aria-label="测试文档">
            <h1>{heading.replace(/^# /, "")}</h1>
            {paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </article>
        </>
      )}
    </main>
  );
}
