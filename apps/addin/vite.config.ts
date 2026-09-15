import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

/**
 * HTTPS for the dev server (Outlook only loads add-ins over https).
 *  1. If `office-addin-dev-certs install` was run, its localhost cert is used
 *     (~/.office-addin-dev-certs/localhost.{crt,key}) — trusted by the OS.
 *  2. Otherwise fall back to @vitejs/plugin-basic-ssl (self-signed, must be trusted manually).
 * Nothing here needs network access at runtime.
 */
async function httpsConfig(): Promise<{ https?: { cert: Buffer; key: Buffer }; plugins: PluginOption[] }> {
  const dir = join(homedir(), ".office-addin-dev-certs");
  const cert = join(dir, "localhost.crt");
  const key = join(dir, "localhost.key");
  if (existsSync(cert) && existsSync(key)) {
    return { https: { cert: readFileSync(cert), key: readFileSync(key) }, plugins: [] };
  }
  try {
    const basicSsl = (await import("@vitejs/plugin-basic-ssl")).default;
    return { plugins: [basicSsl()] };
  } catch {
    return { plugins: [] };
  }
}

export default defineConfig(async ({ command, isPreview }) => {
  const https = command === "serve" && !isPreview ? await httpsConfig() : { plugins: [] };
  return {
    base: "./",
    plugins: [react(), ...https.plugins],
    resolve: { alias: { "@": resolve(__dirname, "src") } },
    server: {
      host: "localhost",
      port: 3000,
      strictPort: true,
      https: https.https,
      headers: { "Access-Control-Allow-Origin": "*" },
    },
    preview: { port: 4173 },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      target: "es2020",
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        input: {
          taskpane: resolve(__dirname, "taskpane.html"),
          commands: resolve(__dirname, "commands.html"),
        },
        output: {
          manualChunks: (id: string) => {
            if (id.includes("node_modules/@fluentui")) return "fluent";
            if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
            return undefined;
          },
        },
      },
    },
  };
});
