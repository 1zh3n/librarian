import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const productOrigin = process.env.LIBRARIAN_API_ORIGIN ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [
    react(),
    tailwind(),
    {
      name: "reader-offline-shell",
      apply: "build",
      generateBundle(_options, bundle) {
        const assets = Object.keys(bundle)
          .filter((file) => /^assets\/[^/]+\.(?:js|css)$/u.test(file))
          .map((file) => `/${file}`);
        this.emitFile({
          type: "asset",
          fileName: "assets/reader-shell.json",
          source: JSON.stringify(assets),
        });
      },
    },
  ],
  server: {
    proxy: {
      "/api": productOrigin,
      "/.auth": productOrigin,
      "/assets": productOrigin,
    },
  },
  build: {
    rolldownOptions: {
      input: {
        reader: fileURLToPath(new URL("./index.html", import.meta.url)),
        login: fileURLToPath(new URL("./login.html", import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [{ name: "editor", test: /node_modules[/\\](?:@codemirror|@lezer)[/\\]/ }],
        },
      },
    },
  },
});
