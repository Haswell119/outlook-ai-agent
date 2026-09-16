/**
 * Refreshes `docs/screenshots/*.png` from a production build in mock mode.
 *
 *   pnpm --filter @oao/admin build
 *   ADMIN_MOCK=true ADMIN_AUTH_MODE=token pnpm --filter @oao/admin start &
 *   node apps/admin/scripts/screenshots.mjs [baseURL]
 *
 * Captures each page at 1440 px and at 1024 px (the documented breakpoint).
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseURL = process.argv[2] ?? "http://127.0.0.1:3111";
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
const executablePath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

/** @type {Array<{name: string, path: string, prepare?: (page: import("@playwright/test").Page) => Promise<void>}>} */
const shots = [
  { name: "overview", path: "/" },
  { name: "system", path: "/system" },
  { name: "approvals", path: "/approvals" },
  { name: "automations", path: "/automations" },
  {
    name: "audit-detail",
    path: "/audit",
    async prepare(page) {
      const link = page.locator('a[href^="/audit/aud-"]').first();
      await link.click();
      await page.getByRole("heading", { name: /Audit event/i }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "policy-test",
    path: "/policy",
    async prepare(page) {
      const panel = page.getByTestId("policy-test-panel");
      await panel.scrollIntoViewIfNeeded();
      await panel
        .getByLabel("Sample text")
        .fill(
          "CONFIDENTIAL - Q2 performance report attached. Please wire to IBAN CH9300762011623852957 before Friday.",
        );
      await panel
        .getByLabel("Recipients")
        .fill("michael.brown@clientco.example\noperations@abccapital.example\nlegal@northbridge.example");
      await panel.getByTestId("policy-test-run").click();
      await page.getByTestId("policy-test-results").waitFor();
      await panel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
  },
  { name: "policy", path: "/policy" },
];

const widths = [
  { suffix: "", width: 1440, height: 1100 },
  { suffix: "-1024", width: 1024, height: 1100 },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  for (const { suffix, width, height } of widths) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale: "en-GB",
      timezoneId: "Europe/Zurich",
    });
    const page = await context.newPage();
    for (const shot of shots) {
      await page.goto(`${baseURL}${shot.path}`, { waitUntil: "networkidle" });
      if (shot.prepare) await shot.prepare(page);
      // The sidebar and the top bar are `sticky`, so a full-page capture taken
      // mid-scroll would render them halfway down the image.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(600);
      const file = path.join(outDir, `${shot.name}${suffix}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`✓ ${path.relative(process.cwd(), file)} (${width}px)`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
