import { parse } from "@babel/parser";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = process.argv[2] ?? fileURLToPath(new URL("../src/", import.meta.url));
const nativeControls = new Set([
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "form",
  "dialog",
  "details",
  "summary",
]);
const componentLibraries =
  /^(?:@heroui\/|@react-(?:aria|stately|types)\/|react-(?:aria(?:-components)?|stately|resizable-panels)(?:\/|$))/u;
const privateImports = {
  "features/navigation/CommandPalette.tsx": [
    "Autocomplete",
    "Collection",
    "Header",
    "ListBox",
    "ListBoxItem",
    "ListBoxSection",
  ],
  "ui/DirectoryTree/DirectoryTree.tsx": [
    "Collection",
    "Group",
    "Tree",
    "TreeItem",
    "TreeItemContent",
  ],
  "ui/ReaderDock/ReaderToolResizeHandle.tsx": ["Focusable"],
  "ui/FilePicker.tsx": ["FileTrigger"],
  "ui/ReaderLocale.tsx": ["I18nProvider"],
};

const panelImports = new Set(["Group", "Panel", "Separator", "usePanelRef"]);

const libraryProps = new Set([
  "selectedKeys",
  "selectedKey",
  "defaultSelectedKeys",
  "selectionMode",
  "onSelectionChange",
  "triggerRef",
  "overlayRef",
  "getTargetRect",
  "isNonModal",
  "shouldForceMount",
]);

function walk(node, visit) {
  if (!node?.type) return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value?.type) walk(value, visit);
  }
}

// Follow local type aliases and bare component aliases to their library import.
// Component implementations may call their library internally. Only their
// parameter types, return type and generic constraints are public.
function checkExports(program, report) {
  const definitions = new Map();
  const libraryNames = new Set();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && componentLibraries.test(statement.source.value)) {
      for (const spec of statement.specifiers) libraryNames.add(spec.local.name);
    }
    const decl = statement.declaration ?? statement;
    if (decl.type === "VariableDeclaration") {
      for (const item of decl.declarations) definitions.set(item.id.name, item);
    } else if (decl.id?.name) definitions.set(decl.id.name, decl);
  }

  function leaks(node, seen) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (node.type === "VariableDeclarator") {
      return leaks(node.id.typeAnnotation, seen) || leaks(node.init, seen);
    }
    if (
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      return [...node.params, node.returnType, node.typeParameters].some((part) =>
        leaks(part, seen),
      );
    }

    let found = false;
    walk(node, (part) => {
      if (part.type === "TSImportType" && componentLibraries.test(part.argument.value))
        found = true;
      if (part.type !== "Identifier") return;
      if (libraryNames.has(part.name) || leaks(definitions.get(part.name), seen)) found = true;
    });
    return found;
  }

  for (const statement of program.body) {
    if (
      !["ExportDefaultDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
        statement.type,
      )
    )
      continue;
    if (statement.source) {
      if (componentLibraries.test(statement.source.value))
        report(statement, "Export a Reader component with its own interface.");
      continue;
    }
    const decl = statement.declaration;
    const exports =
      decl?.type === "VariableDeclaration"
        ? decl.declarations
        : [decl, ...(statement.specifiers ?? []).map((spec) => spec.local)];
    for (const item of exports) {
      if (leaks(item, new Set()))
        report(item, "Keep library components and their prop types inside the implementation.");
    }
  }
}

for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  const name = relative(sourceRoot, path);
  if (!/\.tsx?$/u.test(name) || /^spike\/|\.(?:test|spec)\.tsx?$/u.test(name)) continue;

  const ast = parse(readFileSync(path, "utf8"), {
    sourceType: "module",
    plugins: name.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    createImportExpressions: true,
  });
  const report = (node, message) => {
    process.exitCode = 1;
    console.error(`src/${name}:${node.loc.start.line}: ${message}`);
  };
  checkExports(ast.program, report);
  const isUi = name.startsWith("ui/");
  walk(ast.program, (node) => {
    const source =
      node.source?.value ?? (node.type === "TSImportType" ? node.argument.value : undefined);
    if (typeof source === "string" && componentLibraries.test(source)) {
      const allowed = privateImports[name];
      const privateCollection =
        source === "react-aria-components" &&
        allowed &&
        node.type === "ImportDeclaration" &&
        node.specifiers.every((spec) => allowed.includes(spec.imported?.name));
      const privateDock =
        name === "ui/ReaderDock/ReaderDock.tsx" &&
        source === "react-resizable-panels" &&
        node.type === "ImportDeclaration" &&
        node.specifiers.every((spec) => panelImports.has(spec.imported?.name));
      if (!(isUi && source.startsWith("@heroui/")) && !privateCollection && !privateDock) {
        report(node, `Use a Reader ui/ component for ${source}.`);
      }
    }
    if (
      !isUi &&
      !privateImports[name] &&
      node.type === "JSXAttribute" &&
      libraryProps.has(node.name.name)
    ) {
      report(node, `Keep ${node.name.name} inside the Reader component.`);
    }
    if (!isUi && node.type === "JSXOpeningElement" && nativeControls.has(node.name.name)) {
      report(node, `Use a Reader ui/ component for <${node.name.name}>.`);
    }
  });
}
