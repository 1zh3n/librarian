import { readFileSync, writeFileSync } from "node:fs";

const root = new URL(
  "./dist/types/src/",
  import.meta.resolve("react-aria-components/package.json"),
);
// React Aria 1.22.1 redeclares DOM attributes with React 19's different
// exactOptionalPropertyTypes shape. Keep React Aria's own attribute types.
const declarations = [
  {
    file: "Group.d.ts",
    before: "'render' | 'role' | 'slot'>, DOMProps",
    after: "'render' | 'role' | 'slot' | keyof AriaLabelingProps | keyof DOMProps>, DOMProps",
  },
  {
    file: "OverlayArrow.d.ts",
    before: "'style' | 'render' | 'children'>, RenderProps",
    after: "'style' | 'render' | 'children' | keyof DOMProps>, RenderProps",
  },
];

for (const { file, before, after } of declarations) {
  const url = new URL(file, root);
  const source = readFileSync(url, "utf8");
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`React Aria declaration changed: ${file}`);
  writeFileSync(url, source.replace(before, after));
}
