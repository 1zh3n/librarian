import { useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { analyzeMarkdown } from "../../markdown/analyze";

export function AiAnswer({ id, answer }: { id: string; answer: string }) {
  const body = useMemo(
    () =>
      toJsxRuntime(analyzeMarkdown(answer, id).tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
          img: ({ alt }: { alt?: string }) => <>{alt}</>,
        },
      }),
    [answer, id],
  );
  return <div>{body}</div>;
}
