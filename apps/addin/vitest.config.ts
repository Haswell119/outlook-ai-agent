import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { reactAlias, reactDedupe } from "./react-resolution";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Same single-React guarantee as vite.config.ts — see ./react-resolution.ts.
    alias: { "@": resolve(__dirname, "src"), ...reactAlias },
    dedupe: reactDedupe,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
