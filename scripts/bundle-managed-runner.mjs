import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

// Used by both the release archive and Chromium's native integration fixture.
export function stageManagedRunner(root, bundle) {
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (nodeVersion[0] !== 24 || nodeVersion[1] < 9) {
    throw new Error("Build the managed runner with the Node 24 distribution (24.9 or newer)");
  }
  const nodeLicense = join(dirname(dirname(process.execPath)), "LICENSE");
  if (!existsSync(nodeLicense))
    throw new Error("The Node 24 installation must include its distribution LICENSE");
  copy(process.execPath, join(bundle, "bin/node"));
  copy(nodeLicense, join(bundle, "licenses/node/LICENSE"));
  copy(
    join(root, "deploy/librarian/install-managed-runner"),
    join(bundle, "install-managed-runner"),
  );
  copy(
    join(root, "deploy/librarian/install-managed-runner.mjs"),
    join(bundle, "deploy/librarian/install-managed-runner.mjs"),
  );
  const runnerPath = "bin/librarian/runner";
  const runnerDir = join(bundle, runnerPath);
  const sourceDir = join(root, runnerPath);
  for (const file of readdirSync(sourceDir)) {
    if (
      file === "package.json" ||
      file === "package-lock.json" ||
      (file.endsWith(".mjs") && !file.endsWith(".test.mjs") && file !== "fixtures.mjs")
    ) {
      copy(join(sourceDir, file), join(runnerDir, file));
    }
  }
  return runnerDir;
}

export function bundleManagedRunner(root, bundle) {
  const runnerDir = stageManagedRunner(root, bundle);
  execFileSync(
    "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--workspaces=false", "--no-audit", "--no-fund"],
    {
      cwd: runnerDir,
      stdio: "inherit",
    },
  );
  return runnerDir;
}
