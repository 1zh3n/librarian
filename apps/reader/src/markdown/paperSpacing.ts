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

export interface BlankRun {
  firstLine: number;
  count: number;
}

function headingSize(node?: Element) {
  return node && /^h[1-6]$/.test(node.tagName)
    ? headingSizes[Number(node.tagName[1]) - 1]
    : undefined;
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
      const heading = headingSize(next);
      const gap =
        previous && next
          ? `max(${previousMargin}, ${heading ? `calc(${heading} * 1.7)` : "0px"})`
          : "0px";
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
    const lead = node.tagName === "p" && (!blocks || (blocks === 1 && previous?.tagName === "h1"));
    children.push({
      ...node,
      properties: {
        ...node.properties,
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
