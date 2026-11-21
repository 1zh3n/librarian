import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LIBRARIAN_PRODUCT_TEST_PORT ?? 4176);
const baseURL = `http://127.0.0.1:${port}`;

// The legacy fixture has one shared claim queue across workspaces.
const legacyAi = [
  "document-ai.spec.ts",
  "document-ai-conversations.spec.ts",
  "document-ai-organization.spec.ts",
];

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["document-*.spec.ts", "reading-focus.spec.ts"],
  use: { ...devices["Desktop Chrome"], baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "reader", testIgnore: legacyAi },
    { name: "legacy-ai", testMatch: legacyAi, workers: 1 },
  ],
  webServer: {
    command:
      process.env.LIBRARIAN_READER_FIXTURE && process.platform !== "win32"
        ? `"$LIBRARIAN_READER_FIXTURE" ${port}`
        : `cargo run --locked --quiet -p librarian --example reader_fixture -- ${port}`,
    url: `${baseURL}/api/v1/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 5_000 },
  },
});
