import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
