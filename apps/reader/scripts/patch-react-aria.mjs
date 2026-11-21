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

// HeroUI 3.2.7's generated ListBox declaration reaches every component through
// the barrel. Point its three type references at their defining public modules.
const listBox = new URL(
  "./dist/components/list-box/index.d.ts",
  import.meta.resolve("@heroui/react/package.json"),
);
const source = readFileSync(listBox, "utf8");
const scoped = source
  .replaceAll('import("..").ListBoxItem', 'import("../list-box-item").ListBoxItem')
  .replaceAll('import("..").ListBoxSection', 'import("../list-box-section").ListBoxSection');
if (source !== scoped) writeFileSync(listBox, scoped);
