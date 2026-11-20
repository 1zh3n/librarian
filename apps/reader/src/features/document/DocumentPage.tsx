import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ToggleButton } from "react-aria-components";
import { ApiError } from "../../api/client";
import { documentQuery } from "../../api/queries";
import { analyzeMarkdown } from "../../markdown/analyze";
import { ReaderSurface } from "../../markdown/ReaderSurface";
import styles from "./DocumentPage.module.css";

export function DocumentPage({ workspace, document }: { workspace: string; document: string }) {
  const result = useQuery(documentQuery(workspace, document));
  const source = result.data?.markdown;
  const analysis = useMemo(
    () => (source === undefined ? null : analyzeMarkdown(source, document)),
    [source, document],
  );
  const [contents, setContents] = useState(false);

  if (result.isError && !result.data) {
    const missing = result.error instanceof ApiError && result.error.status === 404;
    return (
      <p role="alert" className={styles.message}>
        {missing ? "此文档不存在" : "无法读取文档"}
      </p>
    );
  }
  if (!result.data || !analysis) return <output className={styles.message}>正在打开文档…</output>;

  const { title } = result.data.document;
  const titleIsFirstHeading =
    analysis.headings[0]?.level === 1 && analysis.headings[0].label === title;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        {!titleIsFirstHeading && <h1 className={styles.title}>{title}</h1>}
      </header>
      <div className={styles.documentTools}>
        {analysis.headings.length > 0 && (
          <ToggleButton
            isSelected={contents}
            onChange={setContents}
            className={styles.contentsButton}
          >
            文档目录
          </ToggleButton>
        )}
      </div>
      <div className={styles.documentGrid} data-contents={contents || undefined}>
        <div className={styles.canvas}>
          <ReaderSurface analysis={analysis} label={title} />
        </div>
        {contents && (
          <nav className={styles.contents} aria-label="文档目录">
            {analysis.headings.map((heading) => (
              <a
                key={heading.id}
                href={`#${encodeURIComponent(heading.id)}`}
                style={{ paddingInlineStart: Math.max(heading.level - 2, 0) * 12 + 8 }}
                onClick={(event) => {
                  event.preventDefault();
                  window.document.getElementById(heading.id)?.scrollIntoView({ block: "start" });
                }}
              >
                {heading.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
