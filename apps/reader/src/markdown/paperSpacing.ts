import type { Element, Root, RootContent } from "hast";

export const headingSizes = [
  "var(--reading-title-size)",
  ...[1.45, 1.17, 1, 0.83, 0.67].map((scale) => `calc(var(--reading-size) * ${scale})`),
];

export function blockEndMargin(headingSize: string | undefined, lead: boolean, table: boolean) {
  if (table) return "0px";
  if (headingSize) return `calc(${headingSize} * .45)`;
  return lead ? "calc(var(--reading-size) * 1.075 * 1.45)" : "var(--reading-size)";
}

// A quote typed on an existing line already occupies one body line. Only a
// larger typographic gap (for example before a heading) needs extra space.
export function blockGap(
  previousMargin: string,
  nextHeading: string | undefined,
  adjacentQuote = false,
) {
  const gap = `max(${previousMargin}, ${nextHeading ? `calc(${nextHeading} * 1.7)` : "0px"})`;
  return adjacentQuote
    ? `max(0px, ${gap} - var(--reading-size) * var(--reading-line-height))`
    : gap;
}

export interface BlankRun {
  firstLine: number;
  count: number;
}

function headingSize(node?: Element) {
  return node && /^h[1-6]$/.test(node.tagName)
    ? headingSizes[Number(node.tagName[1]) - 1]
    : undefined;
}

// Markdown parsers omit quote-marker-only lines from the semantic children.
// Keep their source line numbers so each row can also receive a paper click.
function quoteChildren(quote: Element): Element["children"] {
  if (!quote.position) return quote.children;
  let line = quote.position.start.line;
  const children: Element["children"] = [];
  function fill(until: number) {
    if (line >= until) return;
    const count = until - line;
    children.push({
      type: "element",
      tagName: "div",
      properties: {
        ariaHidden: "true",
        dataQuoteBlankLine: line,
        dataBlankCount: count,
        style: `height: ${count}lh`,
      },
      children: [],
    });
  }
  for (const child of quote.children) {
    if (child.type === "element" && child.position) {
      fill(child.position.start.line);
      line = child.position.end.line + 1;
      children.push(
        child.tagName === "blockquote" ? { ...child, children: quoteChildren(child) } : child,
      );
    } else children.push(child);
  }
  fill(quote.position.end.line + 1);
  return children;
}

// The parser omits blank source lines. Give each run one layout box while
// keeping the semantic blocks and their source positions intact.
export function paperTree(tree: Root, blankLines: readonly BlankRun[]): Root {
  const children: RootContent[] = [];
  let index = 0;
  let previous: Element | undefined;
  let previousMargin = "0px";
  let blocks = 0;

  function insertBlanks(next?: Element) {
    while (index < blankLines.length) {
      const run = blankLines[index]!;
      if (next && run.firstLine >= (next.position?.start.line ?? 0)) break;
      const gap = previous && next ? blockGap(previousMargin, headingSize(next)) : "0px";
      children.push({
        type: "element",
        tagName: "div",
        properties: {
          ariaHidden: "true",
          dataBlankLine: run.firstLine,
          dataBlankCount: run.count,
          style: `--extra-lines: ${run.count - 1}; --paragraph-gap: ${gap}; margin-block-end: ${next ? "0px" : previousMargin}`,
        },
        children: [],
      });
      index++;
    }
  }

  for (const node of tree.children) {
    if (node.type !== "element" || !node.position) {
      children.push(node);
      continue;
    }
    insertBlanks(node);
    const adjacentQuote =
      previous?.position &&
      previous.position.end.line + 1 === node.position.start.line &&
      (previous.tagName === "blockquote" || node.tagName === "blockquote");
    const lead = node.tagName === "p" && (!blocks || (blocks === 1 && previous?.tagName === "h1"));
    children.push({
      ...node,
      ...(node.tagName === "blockquote" && { children: quoteChildren(node) }),
      properties: {
        ...node.properties,
        ...(adjacentQuote && {
          style: `--quote-join-gap: ${blockGap(previousMargin, headingSize(node), true)}`,
        }),
        ...(!blocks && { dataPaperFirst: true }),
        ...(lead && { dataPaperLead: true }),
      },
    });
    previous = node;
    previousMargin = blockEndMargin(headingSize(node), lead, node.tagName === "table");
    blocks++;
  }
  insertBlanks();
  return { ...tree, children };
}
