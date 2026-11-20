import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";

const output = new URL("../apps/reader/src/api/schema.gen.ts", import.meta.url);
const types = await openapiTS(new URL("./librarian.openapi.json", import.meta.url));
const source = "// Generated from api/librarian.openapi.json. Run npm run api:generate -w @librarian/reader.\n\n" + astToString(types);
const formatted = spawnSync("oxfmt", ["--stdin-filepath=src/api/schema.gen.ts"], {
  input: source,
  encoding: "utf8",
});
if (formatted.status !== 0) {
  throw new Error(formatted.error?.message ?? formatted.stderr);
}
if (process.argv.includes("--check")) {
  const saved = await readFile(output, "utf8");
  if (formatted.stdout !== saved) {
    throw new Error("Generated API types differ from the OpenAPI contract. Run api:generate.");
  }
} else {
  await writeFile(output, formatted.stdout);
}
