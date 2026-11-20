import type { Root as HastRoot } from "hast";
import rehypeSanitize from "rehype-sanitize";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { collectBlocks } from "./blocks";
import type { Block } from "./blocks";

const reader = unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .freeze();

export type MarkdownAnalysis = { readonly blocks: readonly Block[]; readonly tree: HastRoot };

export function analyzeMarkdown(markdown: string, documentId: string): MarkdownAnalysis {
  const bom = markdown.startsWith("\uFEFF") ? 1 : 0;
  const parsed = reader.parse(markdown.slice(bom));
  const tree = reader.runSync(parsed);
  const blocks = collectBlocks(parsed, markdown, documentId, bom);
  const byStart = new Map(blocks.map((block) => [block.from, block]));
  for (const child of tree.children) {
    const start = child.position?.start.offset;
    if (child.type !== "element" || start === undefined) {
      continue;
    }
    const block = byStart.get(start + bom);
    if (block) {
      child.properties.dataBlockId = block.id;
    }
  }
  return { blocks, tree };
}
