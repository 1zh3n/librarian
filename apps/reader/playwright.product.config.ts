import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LIBRARIAN_PRODUCT_TEST_PORT ?? 4176);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["document-*.spec.ts", "reading-focus.spec.ts"],
  use: { ...devices["Desktop Chrome"], baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `cargo run --locked --quiet -p librarian --example reader_fixture -- ${port}`,
    url: `${baseURL}/api/v1/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGINT", timeout: 5_000 },
  },
});
