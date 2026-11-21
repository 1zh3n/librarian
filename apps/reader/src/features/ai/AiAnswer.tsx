import { type ComponentProps, useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { analyzeMarkdown } from "../../markdown/analyze";
import styles from "./AiPanel.module.css";

function AnswerTable(props: ComponentProps<"table">) {
  return (
    <section className={styles.tableScroll} aria-label="回答表格">
      <table {...props} />
    </section>
  );
}

export function AiAnswer({ id, answer }: { id: string; answer: string }) {
  const body = useMemo(
    () =>
      toJsxRuntime(analyzeMarkdown(answer, id).tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
          table: AnswerTable,
          img: ({ alt }: { alt?: string }) => <>{alt}</>,
        },
      }),
    [answer, id],
  );
  return <div>{body}</div>;
}
