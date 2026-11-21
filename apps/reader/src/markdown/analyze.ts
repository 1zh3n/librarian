import type { Element, Root as HastRoot } from "hast";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { collectBlocks } from "./blocks";
import type { Block } from "./blocks";

import type { BlankRun } from "./paperSpacing";

const reader = unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkRehype, {
    handlers: {
      // The reading surface preserves soft newlines. A hard break already has
      // a semantic BR and needs no additional newline text node.
      break(state, node) {
        const br: Element = { type: "element", tagName: "br", properties: {}, children: [] };
        state.patch(node, br);
        return state.applyData(node, br);
      },
    },
  })
  .use(rehypeSanitize)
  .freeze();

export type DocumentHeading = {
  readonly id: string;
  readonly label: string;
  readonly level: number;
};

export type MarkdownAnalysis = {
  readonly blocks: readonly Block[];
  readonly headings: readonly DocumentHeading[];
  readonly blankLines: readonly BlankRun[];
  readonly tree: HastRoot;
};

function headingText(node: Element): string {
  return node.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type !== "element") return "";
      if (child.tagName === "img" && typeof child.properties.alt === "string") {
        return child.properties.alt;
      }
      return headingText(child);
    })
    .join("");
}

export function analyzeMarkdown(markdown: string, documentId: string): MarkdownAnalysis {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const parsed = reader.parse(markdown.slice(bom));
  const tree = reader.runSync(parsed);
  const blocks = collectBlocks(parsed, markdown, documentId, bom);
  const byStart = new Map(blocks.map((block) => [block.from, block]));
  const headings: DocumentHeading[] = [];
  for (const child of tree.children) {
    const start = child.position?.start.offset;
    if (child.type !== "element" || start === undefined) {
      continue;
    }
    const block = byStart.get(start + bom);
    if (block) {
      child.properties.dataBlockId = block.id;
      if (block.kind === "heading") {
        const level = Number(child.tagName.slice(1));
        const label = headingText(child).trim();
        if (label && level >= 1 && level <= 6) {
          child.properties.id = block.id;
          headings.push({ id: block.id, level, label });
        }
      }
    }
  }
  const blankLines: BlankRun[] = [];
  let firstLine = 1;
  for (const node of parsed.children) {
    if (!node.position) continue;
    const count = node.position.start.line - firstLine;
    if (count > 0) blankLines.push({ firstLine, count });
    firstLine = node.position.end.line + 1;
  }
  const count = (parsed.position?.end.line ?? 1) - firstLine + 1;
  if (count > 0) blankLines.push({ firstLine, count });
  return { blocks, headings, tree, blankLines };
}
