// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const checker = fileURLToPath(new URL("../scripts/check-ui-boundary.mjs", import.meta.url));

function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "reader-ui-boundary-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("rejects library re-exports, pass-through props and library types in business modules", () => {
  const files = {
    "ui/primitives.ts": 'export { Menu as ReaderMenu } from "@heroui/react/menu";',
    "ui/BadMenu.tsx":
      'import {Menu as Raw} from "@heroui/react/menu"; import type {ComponentProps} from "react"; type Props = ComponentProps<typeof Raw>; export function ReaderMenu(p: Props) {return <Raw {...p}/>;}',
    "ui/Keys.ts":
      'import type {Selection as Keys} from "react-aria-components"; export type Selected = Keys;',
    "ui/ReaderDock/ReaderDock.tsx": 'import * as panels from "react-resizable-panels";',
    "ui/ReaderDock/ReaderToolResizeHandle.tsx":
      'import { Focusable, Menu } from "react-aria-components";',
    "ui/Other.tsx":
      'import {Menu} from "react-aria-components"; export function Actions(){return <Menu/>;}',
    "routes/Tool.tsx":
      'import {Tabs} from "../ui/Tabs"; export function Tool(){return <Tabs selectedKey="ai" onSelectionChange={String}/>;}',
    "ui/collection.d.ts": 'export type Selection = import("react-aria-components").Selection;',
    "ui/Alias.ts":
      'import {Modal as Raw} from "@heroui/react/modal"; export const Dialog = Raw.Dialog;',
    "routes/example.ts": 'type Items = import("@react-types/shared").Collection<object>;',
    "features/navigation/CommandPalette.tsx": 'import {Modal} from "react-aria-components";',
    "routes/Layout.ts": 'import {Panel} from "react-resizable-panels";',
  };
  const result = check(files);
  for (const name of Object.keys(files)) expect(result.stderr).toContain(name);
  expect(result.status).toBe(1);
});

test("permits owned component contracts and private command list semantics", () => {
  const result = check({
    "ui/ReaderDock/ReaderToolResizeHandle.tsx":
      'import { Focusable } from "react-aria-components";',
    "ui/DirectoryTree/DirectoryTree.tsx":
      'import { Collection, Tree, Group, TreeItem, TreeItemContent } from "react-aria-components";',
    "ui/Menu.tsx":
      'import {Menu as HeroMenu} from "@heroui/react/menu"; export function Actions({label}: {label:string}) {return <HeroMenu aria-label={label}/>;}',
    "ui/primitives.ts": 'export {Actions} from "./Menu";',
    "features/navigation/CommandPalette.tsx":
      'import {Autocomplete, Collection, ListBox} from "react-aria-components";',
    "routes/example.tsx":
      'import {Actions} from "../ui/primitives"; export const Toolbar = () => <Actions label="操作"/>;',
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
