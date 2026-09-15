/**
 * `pnpm --filter @oao/addin e2e`
 *
 * Builds `dist/` if it is missing or stale, then runs the Playwright specs
 * against `vite preview`. Kept as a script (rather than a raw `playwright test`)
 * so a developer can type one command and so CI does not need to remember the
 * build step or the browser path.
 *
 * Env:
 *   E2E_SKIP_BUILD=1   use the existing dist/ as-is
 *   E2E_PORT=4173      preview port
 *   PW_CHROMIUM_PATH   chromium executable (default /opt/pw-browsers/chromium)
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

function newestMtime(dir, skip = new Set(["node_modules", "dist", "e2e-results", "e2e-report"])) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

function run(command, args, extraEnv = {}) {
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...extraEnv }, shell: false });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const builtAt = existsSync(join(dist, "taskpane.html")) ? statSync(join(dist, "taskpane.html")).mtimeMs : 0;
const sourceAt = Math.max(newestMtime(join(root, "src")), statSync(join(root, "taskpane.html")).mtimeMs, statSync(join(root, "vite.config.ts")).mtimeMs);

if (process.env.E2E_SKIP_BUILD !== "1" && builtAt < sourceAt) {
  console.log("[e2e] dist/ is stale — building…");
  run("npx", ["vite", "build", "-c", "vite.commands.config.ts"]);
  run("npx", ["vite", "build"]);
} else {
  console.log("[e2e] reusing dist/");
}

run("npx", ["playwright", "test", ...process.argv.slice(2)], {
  PW_CHROMIUM_PATH: process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers",
});
