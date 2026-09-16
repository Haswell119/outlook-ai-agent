import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite for `@oao/admin`.
 *
 * Runs against a **production build** (`next start`) in the two modes that need
 * no external service: `ADMIN_MOCK=true` (deterministic dataset) and
 * `ADMIN_AUTH_MODE=token` (the development identity, so no Entra ID round-trip).
 *
 * Chromium is the one already installed in the image; its path can be overridden
 * with `PW_CHROMIUM_PATH`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3111);
const baseURL = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    locale: "en-GB",
    timezoneId: "Europe/Zurich",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          executablePath,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
      },
    },
  ],
  webServer: {
    // `pnpm --filter @oao/admin build` must have run first.
    command: `npx next start -p ${PORT}`,
    url: `${baseURL}/api/ping`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      ADMIN_MOCK: "true",
      ADMIN_AUTH_MODE: "token",
      ADMIN_TENANT_NAME: "Northbridge Capital",
      ADMIN_TZ: "Europe/Zurich",
      ADMIN_DEFAULT_LANGUAGE: "en",
      ADMIN_DEV_EMAIL: "admin@northbridge.example",
      ADMIN_DEV_NAME: "Dashboard Operator",
      ADMIN_DEV_ROLES: "admin",
    },
  },
});
