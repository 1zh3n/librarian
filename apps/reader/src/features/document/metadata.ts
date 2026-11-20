import { isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import type { Node, Scalar } from "yaml";
import type { TextEdit } from "../../editor/document";

const keys = ["title", "series", "status"] as const;
const metadataLimit = 32 * 1024;
type MetadataKey = (typeof keys)[number];
type EditableValues = Record<MetadataKey, string>;
export type MetadataChanges = Partial<EditableValues & { addTag: string }>;

function frontMatter(source: string) {
  const prefix = source.slice(0, metadataLimit);
  const opening = /^(?:\uFEFF)?---(\r\n|\r|\n)/.exec(prefix);
  if (!opening) return { kind: "missing" } as const;
  const start = opening[0].length;
  const yamlAndBody = prefix.slice(start);
  const delimiter = /(?:^|\r\n|\r|\n)---(?=\r\n|\r|\n|$)/.exec(yamlAndBody);
  if (!delimiter) return { kind: "invalid" } as const;
  const end = start + delimiter.index + delimiter[0].length - 3;
  const yaml = source.slice(start, end);
  const parsed = parseDocument(yaml);
  if (parsed.errors.length > 0 || (parsed.contents !== null && !isMap(parsed.contents))) {
    return { kind: "invalid" } as const;
  }
  return {
    kind: "valid",
    map: parsed.contents,
    start,
    end,
    yaml,
    eol: opening[1] ?? "\n",
  } as const;
}

function scalar(value: unknown): string {
  return isScalar(value) && typeof value.value === "string" ? value.value : "";
}

function tagsIn(node: unknown): string[] {
  if (isSeq(node)) return node.items.map(scalar).filter(Boolean);
  return scalar(node).split(/\s+/u).filter(Boolean);
}

export function readMetadata(
  source: string,
): EditableValues & { tags: string[]; invalid: boolean } {
  const matter = frontMatter(source);
  const map = matter.kind === "valid" ? matter.map : null;
  return {
    title: scalar(map?.get("title", true)),
    series: scalar(map?.get("series", true)),
    status: scalar(map?.get("status", true)),
    tags: tagsIn(map?.get("tags", true)),
    invalid: matter.kind === "invalid",
  };
}

function format(value: string, node?: Scalar): string {
  const style = node?.type;
  const quote = style === "QUOTE_DOUBLE" || style === "QUOTE_SINGLE" ? style : undefined;
  return stringify(value, { lineWidth: 0, ...(quote && { defaultStringType: quote }) }).trimEnd();
}

export function metadataEdits(source: string, changes: MetadataChanges): TextEdit[] {
  const matter = frontMatter(source);
  if (matter.kind === "invalid") throw new Error("Front Matter 无法解析，请在完整源码中修改");
  const tag = changes.addTag?.trim();
  if (tag && /\s/u.test(tag)) throw new Error("请一次输入一个标签，标签内不能有空格");

  const updates = new Map<string, string>();
  for (const key of keys) {
    const value = changes[key]?.trim();
    if (value !== undefined) updates.set(key, value);
  }
  if (matter.kind === "missing") {
    if (tag) updates.set("tags", tag);
    const eol = /\r\n|\r|\n/.exec(source)?.[0] ?? "\n";
    const lines = [...updates]
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${format(value)}`);
    if (!lines.length) return [];
    const at = source.startsWith("\uFEFF") ? 1 : 0;
    return [{ from: at, to: at, insert: ["---", ...lines, "---", ""].join(eol) }];
  }

  const { start, end, map, yaml, eol } = matter;
  const edits: TextEdit[] = [];
  const newFields: string[] = [];
  const tags = map?.get("tags", true);
  if (tag && !tagsIn(tags).includes(tag)) {
    if (isSeq(tags)) {
      edits.push(tagAddition(tags, tag, yaml, start, eol));
    } else {
      const existing = tagsIn(tags).join(" ");
      updates.set("tags", existing ? `${existing} ${tag}` : tag);
    }
  }
  for (const [key, value] of updates) {
    const node = map?.get(key, true);
    if (scalar(node) === value) continue;
    if (!node) {
      newFields.push(`${key}: ${format(value)}`);
      continue;
    }
    if (!isScalar(node) || !node.range || node.type?.startsWith("BLOCK_")) {
      throw new Error(`${key} 使用特殊 YAML 语法，请在完整源码中修改`);
    }
    const [from, to] = node.range;
    const padding = yaml[from - 1] === ":" ? " " : "";
    edits.push({ from: start + from, to: start + to, insert: padding + format(value, node) });
  }
  if (newFields.length) edits.push({ from: end, to: end, insert: newFields.join(eol) + eol });
  return edits.sort((a, b) => a.from - b.from);
}

function tagAddition(
  tags: Node & { flow?: boolean; items: readonly unknown[] },
  tag: string,
  yaml: string,
  start: number,
  eol: string,
): TextEdit {
  if (!tags.range) throw new Error("标签列表需要在完整源码中修改");
  const [from, to] = tags.range;
  if (tags.flow) {
    const last = tags.items.at(-1);
    if (tags.items.length && (!isScalar(last) || !last.range)) {
      throw new Error("标签列表需要在完整源码中修改");
    }
    const at = start + (isScalar(last) && last.range ? last.range[1] : to - 1);
    const separator = tags.items.length ? ", " : "";
    return { from: at, to: at, insert: separator + JSON.stringify(tag) };
  }
  const indentStart =
    Math.max(yaml.lastIndexOf("\n", from - 1), yaml.lastIndexOf("\r", from - 1)) + 1;
  const indent = yaml.slice(indentStart, from);
  if (!/^ *$/u.test(indent)) throw new Error("标签列表需要在完整源码中修改");
  const suffix = /[\r\n]/u.test(yaml[to - 1] ?? "") ? "" : eol;
  const at = start + to;
  return { from: at, to: at, insert: `${suffix}${indent}- ${format(tag)}${eol}` };
}
