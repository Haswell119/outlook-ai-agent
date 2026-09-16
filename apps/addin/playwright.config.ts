/**
 * End-to-end tests against the real production bundle.
 *
 * Two suites, both on `vite preview` (the built `dist/`):
 *
 *  - `taskpane.spec.ts` runs in browser-preview + mock mode (`?mock=1`): the
 *    same code path Outlook loads, minus the Office host and the backend.
 *  - `sim.spec.ts` injects the **Office.js host simulator** (`e2e/office-sim/`)
 *    into `taskpane.html` and talks to a **real orchestrator** in mock-LLM mode,
 *    which is what makes item switching, triage, degradation and the error
 *    states testable at all.
 *
 * Both exercise the lazy chunks, the CSP meta, the IndexedDB cache and the real
 * Fluent rendering, none of which jsdom covers.
 *
 * Chromium: this image ships Playwright's browsers under `/opt/pw-browsers`.
 * `PW_CHROMIUM_PATH` (or the default symlink) is passed as `executablePath`, so
 * no browser download is needed in CI.
 */
import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.E2E_PORT ?? 4173);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
/** The orchestrator `sim.spec.ts` talks to (mock LLM, in-memory database). */
const API_PORT = Number(process.env.E2E_API_PORT ?? 8080);
const ORCHESTRATOR = resolve(dirname(fileURLToPath(import.meta.url)), "../orchestrator/dist/server.js");

function chromiumPath(): string | undefined {
  const candidates = [process.env.PW_CHROMIUM_PATH, "/opt/pw-browsers/chromium", process.env.CHROMIUM_PATH].filter(
    (p): p is string => !!p,
  );
  return candidates.find((p) => existsSync(p));
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // A cold model call in the mock client is ~2.5 s; give each test room without
  // hiding a real hang.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]] : [["list"]],
  outputDir: "e2e-results",
  use: {
    baseURL: BASE_URL,
    locale: "en-GB",
    timezoneId: "Europe/Zurich",
    // The pane's real width in Outlook desktop.
    viewport: { width: 420, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: chromiumPath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  projects: [
    { name: "taskpane", use: { ...devices["Desktop Chrome"], viewport: { width: 420, height: 900 } } },
  ],
  /**
   * Both servers the suite needs, started by Playwright itself:
   *   1. the orchestrator — real HTTP, real triage, real caching, real audit
   *      trail, with the deterministic mock model provider and an in-memory
   *      database so a run needs no PostgreSQL and no API key;
   *   2. `vite preview` on the built bundle.
   *
   * `reuseExistingServer` keeps a developer's own `pnpm dev` stack usable.
   * Set E2E_NO_SERVER=1 when both are already running.
   */
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: `node ${JSON.stringify(ORCHESTRATOR)}`,
          url: `http://localhost:${API_PORT}/api/v1/health`,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "ignore",
          stderr: "pipe",
          env: {
            ROLE: "all",
            LLM_PROVIDER: "mock",
            DATABASE_URL: "memory",
            AUTH_MODE: "dev",
            PORT: String(API_PORT),
            HOST: "127.0.0.1",
            LOG_LEVEL: "warn",
            CORS_ORIGINS: `https://localhost:3000,http://localhost:${PORT}`,
          },
        },
        {
          command: `npx vite preview --port ${PORT} --strictPort`,
          port: PORT,
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "ignore",
          stderr: "pipe",
        },
      ],
});
