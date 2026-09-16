import { defineConfig, type Plugin, type PluginOption, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { resolve, join, relative } from "node:path";
import { buildCsp } from "./src/security/csp";

/**
 * Single root `.env`: Vite only reads `apps/addin/.env*`, so VITE_* keys from the
 * repository-root `.env` are merged into process.env here (never overriding a
 * value already present in the shell or in the local file — Vite gives
 * process.env precedence, so the local file is loaded first).
 */
function mergeRootEnv(): void {
  const parse = (file: string): Record<string, string> => {
    if (!existsSync(file)) return {};
    const out: Record<string, string> = {};
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^(?:export\s+)?(VITE_[A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
      if (!m) continue;
      let v = m[2] ?? "";
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s#.*$/, "").trim();
      out[m[1]!] = v;
    }
    return out;
  };
  const local = parse(resolve(__dirname, ".env"));
  const root = parse(resolve(__dirname, "../../.env"));
  for (const [k, v] of Object.entries({ ...root, ...local })) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
  }
}
mergeRootEnv();

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

function gitCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 12);
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "local";
  }
}

/**
 * Injects the Content-Security-Policy meta tag into every HTML entry, with
 * `connect-src` narrowed to the configured backend origin. The policy lives in
 * `src/security/csp.ts` so it is unit-tested rather than hand-maintained twice.
 */
function cspPlugin(options: { apiOrigin?: string; dev: boolean; extraConnect: string[] }): Plugin {
  return {
    name: "oao-csp",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const policy = buildCsp({ apiOrigin: options.apiOrigin, dev: options.dev, extraConnect: options.extraConnect });
        const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}" />`;
        if (html.includes("OAO_CSP")) return html.replace(/<!--\s*OAO_CSP:[\s\S]*?-->/, tag);
        return html.replace("<head>", `<head>\n    ${tag}`);
      },
    },
  };
}

/**
 * Prints the gzipped size of every emitted asset and fails the build when the
 * main entry chunk exceeds the budget. Keeps the "instant pane" promise
 * enforceable in CI instead of aspirational.
 */
function budgetPlugin(options: { mainBudgetGz: number; totalBudgetGz: number }): Plugin {
  return {
    name: "oao-bundle-budget",
    apply: "build",
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      if (!existsSync(dist)) return;
      const rows: Array<{ file: string; raw: number; gz: number }> = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (/\.(js|css)$/.test(entry.name)) {
            const buf = readFileSync(full);
            rows.push({ file: relative(dist, full), raw: statSync(full).size, gz: gzipSync(buf).length });
          }
        }
      };
      walk(dist);
      rows.sort((a, b) => b.gz - a.gz);
      const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
      const totalGz = rows.reduce((sum, r) => sum + r.gz, 0);
      // eslint-disable-next-line no-console
      console.log("\n  bundle sizes (gzip)");
      for (const r of rows) console.log(`  ${kb(r.gz).padStart(9)}  ${kb(r.raw).padStart(9)} raw  ${r.file}`);
      console.log(`  ${kb(totalGz).padStart(9)}  total js+css (gzip)\n`);

      // The "main chunk" is the entry the task pane loads first plus the React
      // and Fluent vendor chunks it depends on synchronously.
      const mainish = rows.filter((r) => /^assets\/(taskpane|index|react|fluent)-/.test(r.file));
      const mainGz = mainish.reduce((sum, r) => sum + r.gz, 0);
      console.log(`  main entry (taskpane + react + fluent): ${kb(mainGz)} gzip (budget ${kb(options.mainBudgetGz)})`);
      if (mainGz > options.mainBudgetGz) {
        this.error(`bundle budget exceeded: main entry is ${kb(mainGz)} gzip, budget is ${kb(options.mainBudgetGz)}`);
      }
      if (totalGz > options.totalBudgetGz) {
        // eslint-disable-next-line no-console
        console.warn(`  warning: total js+css is ${kb(totalGz)} gzip (soft budget ${kb(options.totalBudgetGz)})`);
      }
    },
  };
}

export default defineConfig(async ({ command, isPreview }): Promise<UserConfig> => {
  const dev = command === "serve" && !isPreview;
  const https = dev ? await httpsConfig() : { plugins: [] };
  // Must mirror `apiBaseUrl()` in src/api/client.ts, otherwise the CSP would
  // block the very origin the client falls back to.
  const apiOrigin = process.env.VITE_API_BASE_URL?.trim() || (dev ? "http://localhost:8080" : "https://localhost:8443");
  const extraConnect = [process.env.VITE_TELEMETRY_URL, process.env.VITE_APPINSIGHTS_INGESTION_ORIGIN].filter((v): v is string => !!v);

  const visualizer: PluginOption[] = [];
  if (process.env.ANALYZE === "1") {
    try {
      const { visualizer: v } = await import("rollup-plugin-visualizer");
      visualizer.push(v({ filename: "dist/stats.html", gzipSize: true, template: "treemap" }) as PluginOption);
    } catch {
      /* optional */
    }
  }

  return {
    base: "./",
    plugins: [
      react(),
      cspPlugin({ apiOrigin, dev, extraConnect }),
      ...https.plugins,
      ...visualizer,
      budgetPlugin({ mainBudgetGz: 250 * 1024, totalBudgetGz: 700 * 1024 }),
    ],
    resolve: { alias: { "@": resolve(__dirname, "src") } },
    define: {
      __OAO_BUILD__: JSON.stringify({
        version: process.env.ADDIN_VERSION ?? "1.0.0",
        commit: gitCommit(),
        builtAt: new Date().toISOString(),
      }),
    },
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
      // Hidden source maps: shipped for stack-trace symbolication by the ops
      // team, never referenced from the bundle, so no browser fetches them.
      // `ADDIN_SOURCEMAP=false` skips them entirely (the icon-font maps are large).
      sourcemap: process.env.ADDIN_SOURCEMAP === "false" ? false : "hidden",
      target: "es2020",
      chunkSizeWarningLimit: 600,
      cssCodeSplit: true,
      rollupOptions: {
        input: {
          taskpane: resolve(__dirname, "taskpane.html"),
          commands: resolve(__dirname, "commands.html"),
        },
        output: {
          // Content-hashed, lower-case, extension-correct names so a static
          // host can serve `assets/*` with `immutable, max-age=31536000` and
          // `X-Content-Type-Options: nosniff` without guessing types.
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks: (id: string) => {
            // @fluentui/react-icons and react-components import each other, so
            // they must share one chunk (splitting them makes it circular).
            if (id.includes("node_modules/@fluentui")) return "fluent";
            if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
            if (id.includes("node_modules/zod")) return "zod";
            return undefined;
          },
        },
      },
    },
  };
});
