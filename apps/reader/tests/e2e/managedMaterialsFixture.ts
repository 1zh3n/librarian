import { expect, test as base } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const target = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");

export const test = base.extend({
  page: async ({ browser }, use) => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    await new Promise<void>((done) => reservation.close(() => done()));
    const baseURL = `http://127.0.0.1:${address.port}`;
    const child = spawn(
      resolve(target, "debug/examples/reader_fixture"),
      [String(address.port), "--managed-materials"],
      { stdio: "ignore" },
    );
    const exited = once(child, "exit");
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await expect
        .poll(async () => (await context.request.get("/api/v1/health").catch(() => null))?.status())
        .toBe(200);
      await use(page);
    } finally {
      await context.close();
      if (child.exitCode === null) child.kill("SIGINT");
      await exited;
    }
  },
});

test.beforeAll(() => {
  // The fixture invokes the product binary as its isolated parser process.
  if (
    existsSync(
      resolve(target, "debug", process.platform === "win32" ? "librarian.exe" : "librarian"),
    )
  )
    return;
  test.setTimeout(180_000);
  execFileSync("cargo", ["build", "--locked", "--quiet", "-p", "librarian", "--bin", "librarian"], {
    cwd: root,
    timeout: 175_000,
  });
});
