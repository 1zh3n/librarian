import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function stageReleaseFiles(root, bundle) {
  const evidence = execFileSync("git", [
    "ls-files", "-z", "--", "docs/librarian/evidence/ai-workspace/",
    "docs/librarian/evidence/managed-reader/", "docs/librarian/evidence/standalone-chat/",
    "docs/librarian/*mcp*.md",
  ], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of [
    "LICENSE.md",
    "docs/librarian/deployment.md",
    "docs/librarian/accounts.md",
    "docs/librarian/lan-pre-release.md",
    "docs/librarian/release-evidence.md",
    "docs/librarian/git-backup.md",
    "docs/librarian/zola-publication.md",
    "docs/librarian/delivery.md",
    "docs/librarian/ai-runner.md",
    "docs/librarian/ai-workspace-acceptance.md",
    "docs/librarian/deepseek-harness-spike-evidence.md",
    ...evidence,
    "deploy/librarian/lan.Caddyfile",
    "deploy/librarian/public.Caddyfile",
    "deploy/librarian/librarian.service",
    "deploy/librarian/librarian.env.example",
    "deploy/librarian/backup.sh",
    "deploy/librarian/restore.sh",
    "deploy/librarian/deploy.sh",
    "deploy/librarian/smoke.sh",
    "deploy/librarian/librarian-backup.service",
    "deploy/librarian/librarian-backup.timer",
    "deploy/librarian/backup.env.example",
    "deploy/librarian/verify-entry-config.mjs",
    "docs/librarian/public-deployment.md",
    "docs/librarian/incident-response.md",
    "bin/librarian/examples/ai_runner.mjs",
  ]) {
    const destination = join(bundle, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, file), destination);
  }
}
