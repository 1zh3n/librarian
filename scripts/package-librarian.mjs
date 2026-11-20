import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (command, args) => execFileSync(command, args, {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
}).trim();
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const legalFile = /^(licen[cs]e|copying|notice|copyright|unlicense)(?:[_.-]|$)/i;

if (process.platform !== "linux" || process.arch !== "x64" || process.argv.length !== 3) {
  throw new Error("Usage on Linux x86_64: node scripts/package-librarian.mjs OUTPUT_DIRECTORY");
}

const destination = resolve(process.argv[2]);
const revision = run("git", ["rev-parse", "HEAD"]);
const timestamp = run("git", ["show", "-s", "--format=%ct", revision]);
if (run("git", ["status", "--porcelain"])) {
  throw new Error("Build and package from a clean release checkout");
}
for (const [program, args] of [
  ["npm", ["run", "build", "-w", "@librarian/reader"]],
  ["cargo", ["build", "--locked", "--release", "-p", "librarian", "-p", "docs"]],
]) {
  execFileSync(program, args, {
    cwd: root, stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: timestamp },
  });
}
const host = run("rustc", ["-vV"]).match(/^host: (.+)$/m)?.[1];
const cargo = readJsonFrom("cargo", [
  "metadata", "--locked", "--offline", "--format-version", "1", "--filter-platform", host,
]);
const product = cargo.packages.find((pkg) => pkg.name === "librarian" && pkg.source === null);
const name = `librarian-${product.version}-linux-x86_64`;
const binaries = join(cargo.target_directory, "release");
const rustGraph = run("cargo", [
  "tree", "--locked", "--offline", "-p", "librarian", "-p", "docs",
  "--edges", "normal,build", "--prefix", "none", "--format", "{p}",
]);
const includedCrates = new Set(rustGraph.split("\n").map((line) => line.split(" ").slice(0, 2).join(" ")));
const reader = readJsonFrom("npm", ["ls", "--workspace", "@librarian/reader", "--omit=dev", "--all", "--long", "--json"]);
const npmPaths = new Set();
const inventory = [];
const staging = mkdtempSync(join(tmpdir(), "librarian-package-"));
const bundle = join(staging, name);

try {
  for (const binary of ["librarian", "docs"]) {
    if (!existsSync(join(binaries, binary))) throw new Error(`Build ${binary} in release mode first`);
    const installed = binary === "docs" ? "bin/docs" : binary;
    copy(join(binaries, binary), join(bundle, installed));
    chmodSync(join(bundle, installed), 0o755);
  }
  for (const file of [
    "LICENSE.md",
    "docs/librarian/deployment.md",
    "docs/librarian/git-backup.md",
    "docs/librarian/zola-publication.md",
    "docs/librarian/delivery.md",
    "docs/librarian/ai-runner.md",
    "bin/librarian/examples/ai_runner.mjs",
  ]) {
    copy(join(root, file), join(bundle, file));
  }

  for (const pkg of cargo.packages) {
    if (!pkg.source || !includedCrates.has(`${pkg.name} v${pkg.version}`)) continue;
    includeLicense("rust", pkg.name, pkg.version, pkg.license, dirname(pkg.manifest_path), pkg.license_file);
  }
  walkNpm(reader);
  for (const tool of ["vite", "rolldown"]) {
    walkNpm({ path: join(root, "node_modules", tool) });
  }
  writeFileSync(join(bundle, "THIRD-PARTY-NOTICES.txt"), [
    "Installed Rust and Reader package licenses and notices",
    "The inventory includes build dependencies and records packages with license metadata alone.",
    "",
    ...inventory.sort(),
    "",
  ].join("\n"));
  writeFileSync(join(bundle, "BUILD-INFO.txt"), [
    `Librarian ${product.version}`,
    `Source ${revision}`,
    `Target ${host}`,
    run("rustc", ["--version"]),
    `Node ${process.version}`,
    ...["librarian", "docs"].map((binary) => {
      const sha256 = createHash("sha256").update(readFileSync(join(binaries, binary))).digest("hex");
      return `${binary} SHA-256 ${sha256}`;
    }),
    "",
  ].join("\n"));
  normalizeModes(bundle);

  mkdirSync(destination, { recursive: true });
  const filename = `${name}.tar.gz`;
  const archive = join(destination, filename);
  run("tar", [
    "--sort=name", `--mtime=@${timestamp}`, "--owner=0", "--group=0", "--numeric-owner",
    "-czf", archive, "-C", staging, name,
  ]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(destination, `${filename}.sha256`), `${digest}  ${filename}\n`);
  process.stdout.write(`${archive}\n${digest}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function readJsonFrom(command, args) {
  return JSON.parse(run(command, args));
}

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function normalizeModes(directory) {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeModes(path);
    } else if (path !== join(bundle, "librarian") && path !== join(bundle, "bin/docs")) {
      chmodSync(path, 0o644);
    }
  }
}

function includeLicense(ecosystem, packageName, version, declaration, directory, explicit) {
  const subdir = join("licenses", ecosystem, `${packageName}-${version}`);
  const paths = readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && legalFile.test(file.name))
    .map((file) => file.name);
  if (explicit && !paths.includes(explicit)) paths.push(explicit);
  for (const file of paths) copy(join(directory, file), join(bundle, subdir, file));
  const license = declaration ?? "No SPDX declaration";
  const included = paths.length ? `  [${subdir}]` : "  [No separate notice in installed package]";
  inventory.push(`${ecosystem}  ${packageName}@${version}  ${license}${included}`);
}

function walkNpm(node) {
  const directory = node.path;
  if (directory && !npmPaths.has(directory)) {
    npmPaths.add(directory);
    const manifest = readJson(join(directory, "package.json"));
    if (!manifest.private) {
      const license = manifest.license ?? manifest.licenses?.map((item) => item.type).join(" OR ");
      includeLicense("npm", manifest.name, manifest.version, license, directory);
    }
  }
  for (const dependency of Object.values(node.dependencies ?? {})) walkNpm(dependency);
}
