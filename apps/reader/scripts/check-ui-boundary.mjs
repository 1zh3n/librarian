import { parse } from "@babel/parser";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
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
const componentLibraries = /^(?:@heroui\/|@react-aria\/|react-aria(?:-components)?(?:\/|$))/u;

function check(node, report) {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration" ||
    node.type === "ImportExpression"
  ) {
    const source = node.source?.value;
    if (typeof source === "string" && componentLibraries.test(source)) {
      report(node, `Import ${source} through Reader ui/.`);
    }
  }
  if (
    node.type === "JSXOpeningElement" &&
    node.name.type === "JSXIdentifier" &&
    nativeControls.has(node.name.name)
  ) {
    report(node, `Use a Reader ui/ component for <${node.name.name}>.`);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item?.type) check(item, report);
    } else if (value.type) {
      check(value, report);
    }
  }
}

for (const entry of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = join(entry.parentPath, entry.name);
  const name = relative(sourceRoot, path);
  if (!/\.tsx?$/u.test(name) || /^(?:ui|spike)\/|\.(?:test|spec|d)\.tsx?$/u.test(name)) {
    continue;
  }
  const ast = parse(readFileSync(path, "utf8"), {
    sourceType: "module",
    plugins: name.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    createImportExpressions: true,
  });
  check(ast.program, (node, message) => {
    process.exitCode = 1;
    console.error(`src/${name}:${node.loc.start.line}: ${message}`);
  });
}
