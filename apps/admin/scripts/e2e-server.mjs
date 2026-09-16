// Starts the production server for Playwright, building first when no build exists.
// Cross-platform (no shell operators); used by playwright.config.ts `webServer.command`.
import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.E2E_PORT ?? "3111";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (!existsSync(join(root, ".next", "BUILD_ID"))) {
  const build = spawnSync(npx, ["next", "build"], { cwd: root, stdio: "inherit", env: process.env });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const server = spawn(npx, ["next", "start", "-p", port], { cwd: root, stdio: "inherit", env: process.env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 0));
