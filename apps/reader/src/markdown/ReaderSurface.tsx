import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import type { MarkdownAnalysis } from "./analyze";

export function ReaderSurface({ analysis }: { readonly analysis: MarkdownAnalysis }) {
  return (
    <article aria-label="测试文档">{toJsxRuntime(analysis.tree, { Fragment, jsx, jsxs })}</article>
  );
}
