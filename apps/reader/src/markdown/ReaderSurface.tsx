import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { MarkdownAnalysis } from "./analyze";
import styles from "./ReaderSurface.module.css";

const components = {
  table: (props: React.ComponentProps<"table">) => (
    <div className={styles.tableScroll}>
      <table {...props} />
    </div>
  ),
};

export function ReaderSurface({
  analysis,
  label = "测试文档",
}: {
  readonly analysis: MarkdownAnalysis;
  readonly label?: string;
}) {
  return (
    <article className={styles.article} aria-label={label}>
      {toJsxRuntime(analysis.tree, { Fragment, jsx, jsxs, components })}
    </article>
  );
}
