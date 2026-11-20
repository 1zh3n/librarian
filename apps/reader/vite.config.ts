import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
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
      "/api": process.env.LIBRARIAN_API_ORIGIN ?? "http://127.0.0.1:8080",
      "/.auth": process.env.LIBRARIAN_API_ORIGIN ?? "http://127.0.0.1:8080",
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "editor", test: /node_modules[/\\](?:@codemirror|@lezer)[/\\]/ }],
        },
      },
    },
  },
});
