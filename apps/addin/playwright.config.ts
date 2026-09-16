/**
 * End-to-end tests against the real production bundle.
 *
 * The specs run against `vite preview` (the built `dist/`) in browser-preview +
 * mock mode (`?mock=1`), which is the same code path Outlook loads, minus the
 * Office host. That is deliberate: it exercises the lazy chunks, the CSP meta,
 * the IndexedDB cache and the real Fluent rendering, none of which jsdom covers.
 *
 * Chromium: this image ships Playwright's browsers under `/opt/pw-browsers`.
 * `PW_CHROMIUM_PATH` (or the default symlink) is passed as `executablePath`, so
 * no browser download is needed in CI.
 */
import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT ?? 4173);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

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
  // `pnpm e2e` starts the preview server itself (scripts/e2e.mjs) so that the
  // build can be reused; set E2E_NO_SERVER=1 when one is already running.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `npx vite preview --port ${PORT} --strictPort`,
        port: PORT,
        reuseExistingServer: true,
        timeout: 60_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
