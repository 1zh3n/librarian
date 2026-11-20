import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentProps, KeyboardEventHandler } from "react";
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
  activeBlocks,
  onKeyDown,
  resolveLink,
}: {
  readonly analysis: MarkdownAnalysis;
  readonly label?: string;
  readonly activeBlocks?: readonly string[] | undefined;
  readonly onKeyDown?: KeyboardEventHandler<HTMLElement>;
  readonly resolveLink?: (href: string) => { href: string; open: () => void } | undefined;
}) {
  const article = useRef<HTMLElement>(null);
  const content = useMemo(
    () =>
      toJsxRuntime(analysis.tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
          ...components,
          ...(resolveLink && {
            a: ({ href, children, ...props }: ComponentProps<"a">) => {
              const target = href ? resolveLink(href) : undefined;
              if (!target)
                return (
                  <a {...props} {...(href && { href })}>
                    {children}
                  </a>
                );
              return (
                <a
                  {...props}
                  href={target.href}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    target.open();
                  }}
                >
                  {children}
                </a>
              );
            },
          }),
        },
      }),
    [analysis.tree, resolveLink],
  );
  useLayoutEffect(() => {
    if (!article.current || !activeBlocks?.length) return;
    const highlighted = activeBlocks.flatMap((id) => {
      const block = article.current?.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (!block) return [];
      block.setAttribute("data-semantic-active", "");
      return [block];
    });
    return () => highlighted.forEach((block) => block.removeAttribute("data-semantic-active"));
  }, [activeBlocks, analysis]);
  return (
    <article
      ref={article}
      className={styles.article}
      aria-label={label}
      data-semantic={activeBlocks?.length ? true : undefined}
      {...(onKeyDown && { onKeyDown, tabIndex: 0 })}
    >
      {content}
    </article>
  );
}
