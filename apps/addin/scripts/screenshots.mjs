/**
 * Takes screenshots of the task pane in browser-preview mode (mock API) with Playwright.
 * Usage: pnpm build && pnpm preview &  then  node scripts/screenshots.mjs [baseUrl]
 * Uses the globally installed playwright if the local one is missing (PLAYWRIGHT_BROWSERS_PATH honoured).
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const spec of ["playwright", "playwright-core", "/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright"]) {
    try {
      return require(spec);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found — npm i -g playwright");
}

const base = process.argv[2] ?? "http://localhost:4173";
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, locale: "en-GB" });
const page = await ctx.newPage();
// Each shot starts from the default (EN) language: forget the manual toggle persisted by a previous shot.
await page.addInitScript(() => {
  try {
    localStorage.removeItem("oao.addin.language");
  } catch {
    /* ignore */
  }
});
page.on("pageerror", (e) => console.error("pageerror", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console", m.text()));

async function shot(name, url, { before, height } = {}) {
  await page.goto(`${base}/${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=header]", { timeout: 30_000 });
  if (before) await before();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  if (height) await page.setViewportSize({ width: 420, height });
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true });
  console.log("saved", name);
}

await shot("summary", "taskpane.html?mock=1", { before: () => page.waitForSelector("[data-testid=summary-tab]", { timeout: 30_000 }) });
await shot("summary-fr", "taskpane.html?mock=1", {
  before: async () => {
    await page.click("button:has-text('FR')");
    await page.waitForSelector("[data-testid=summary-tab]", { timeout: 30_000 });
    await page.waitForTimeout(1200);
  },
});
await shot("thread", "taskpane.html?mock=1&view=thread", { before: () => page.waitForSelector("[data-testid=thread-view]", { timeout: 30_000 }) });
await shot("chat", "taskpane.html?mock=1&tab=chat", {
  before: async () => {
    await page.fill("input[placeholder]", "Find the email where the client approved the mandate.");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-testid=assistant-card]", { timeout: 30_000 });
  },
});
await shot("insights-automation", "taskpane.html?mock=1&tab=insights", {
  before: async () => {
    await page.waitForSelector("[data-testid=automation-coach]", { timeout: 30_000 });
    await page.waitForSelector("[data-testid^=automation-auto]", { timeout: 30_000 });
    await page.click("button:has-text('Run simulation')");
    await page.waitForSelector("[data-testid=simulation-results]", { timeout: 30_000 });
    await page.waitForTimeout(4500); // let the "Simulation completed" toast disappear
  },
});
await shot("compliance", "taskpane.html?mock=1&mode=compose", { before: () => page.waitForSelector("[data-testid=compliance-headline]", { timeout: 30_000 }) });
await shot("approval-dialog", "taskpane.html?mock=1", {
  before: async () => {
    await page.waitForSelector("[data-testid=review-actions]", { timeout: 30_000 });
    await page.click("[data-testid=review-actions]");
    await page.waitForSelector("[data-testid=approve-button]", { timeout: 30_000 });
  },
});
await shot("approval-dialog-wide", "taskpane.html?mock=1", {
  before: async () => {
    await page.setViewportSize({ width: 640, height: 900 });
    await page.waitForSelector("[data-testid=review-actions]", { timeout: 30_000 });
    await page.click("[data-testid=review-actions]");
    await page.waitForSelector("[data-testid=approve-button]", { timeout: 30_000 });
  },
});
await browser.close();
