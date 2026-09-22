/**
 * `npm run e2e -w @oao/addin`
 *
 * Builds what the suite needs, then runs the Playwright specs:
 *
 *   - `dist/` (rebuilt when stale), with `VITE_API_BASE_URL` pointing at the
 *     orchestrator the `sim.spec.ts` suite drives — the value is baked into the
 *     bundle *and* into the CSP `connect-src`, so it cannot be set later;
 *   - `apps/orchestrator/dist/` (built when missing), because Playwright starts
 *     the real orchestrator as one of its `webServer` entries.
 *
 * Env:
 *   E2E_SKIP_BUILD=1     use the existing dist/ as-is
 *   E2E_PORT=4173        preview port
 *   E2E_API_PORT=8080    orchestrator port
 *   VITE_API_BASE_URL    orchestrator URL baked into the bundle
 *   PW_CHROMIUM_PATH     chromium executable (default /opt/pw-browsers/chromium)
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const apiPort = process.env.E2E_API_PORT ?? "8080";
const apiBaseUrl = process.env.VITE_API_BASE_URL ?? `http://localhost:${apiPort}`;
const orchestrator = join(root, "..", "orchestrator");

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

// `sim.html` is opt-in at build time (ADDIN_SIM=1), so a dist/ built for
// production counts as stale for this suite.
const builtAt = existsSync(join(dist, "taskpane.html")) && existsSync(join(dist, "sim.html")) ? statSync(join(dist, "taskpane.html")).mtimeMs : 0;
const sourceAt = Math.max(newestMtime(join(root, "src")), statSync(join(root, "taskpane.html")).mtimeMs, statSync(join(root, "vite.config.ts")).mtimeMs);

if (process.env.E2E_SKIP_BUILD !== "1" && builtAt < sourceAt) {
  console.log(`[e2e] dist/ is stale — building with VITE_API_BASE_URL=${apiBaseUrl}…`);
  run("npx", ["vite", "build", "-c", "vite.commands.config.ts"], { VITE_API_BASE_URL: apiBaseUrl });
  run("npx", ["vite", "build"], { VITE_API_BASE_URL: apiBaseUrl, ADDIN_SIM: "1" });
} else {
  console.log("[e2e] reusing dist/");
}

// The orchestrator is started by Playwright's webServer; it has to be built.
if (!existsSync(join(orchestrator, "dist", "server.js"))) {
  console.log("[e2e] building the orchestrator (needed by sim.spec.ts)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["run", "build", "-w", "@oao/orchestrator"], { cwd: join(root, "..", ".."), stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error("[e2e] could not build the orchestrator — run `npm run build -w @oao/orchestrator` first");
    process.exit(r.status ?? 1);
  }
}

run("npx", ["playwright", "test", ...process.argv.slice(2)], {
  PW_CHROMIUM_PATH: process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers",
  E2E_API_PORT: apiPort,
  E2E_API_URL: apiBaseUrl,
});
