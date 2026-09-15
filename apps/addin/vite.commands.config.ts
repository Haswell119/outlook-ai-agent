/**
 * Builds the self-contained `commands.js` used by the JavaScript-only runtime of
 * classic Outlook on Windows (manifest `<Override type="javascript" resid="Commands.Js"/>`).
 * Output goes to public/ so it is served by the dev server and copied into dist/.
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  define: { "import.meta.env.DEV": JSON.stringify(process.env.NODE_ENV !== "production") },
  build: {
    outDir: "public",
    emptyOutDir: false,
    copyPublicDir: false,
    sourcemap: false,
    minify: true,
    target: "es2017",
    lib: {
      entry: resolve(__dirname, "src/commands/commands.ts"),
      formats: ["iife"],
      name: "OaoCommands",
      fileName: () => "commands.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
