/**
 * Screenshots of the task pane in browser-preview mode (mock API) with Playwright.
 *
 * Usage:  npm run build && npm run preview &   then   node scripts/screenshots.mjs [baseUrl]
 * (or just `node scripts/screenshots.mjs` — it starts `vite preview` itself).
 *
 * Every shot starts from a clean browser context so the local analysis cache and
 * the persisted language of a previous shot cannot leak into the next one.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const spec of ["playwright", "playwright-core", "@playwright/test", "/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright"]) {
    try {
      return require(spec);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found — npm i -g playwright");
}

function chromiumPath() {
  for (const p of [process.env.PW_CHROMIUM_PATH, "/opt/pw-browsers/chromium", process.env.CHROMIUM_PATH]) {
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "screenshots");
mkdirSync(outDir, { recursive: true });

const PORT = Number(process.env.SHOT_PORT ?? 4174);
const base = process.argv[2] ?? `http://localhost:${PORT}`;

/** Start `vite preview` unless a base URL was supplied. */
let server;
if (!process.argv[2]) {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/taskpane.html`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });

/**
 * One shot = one fresh context (clean storage) + one page.
 * `colorScheme` drives `prefers-color-scheme`, which is how the pane picks the
 * dark palette when the user leaves the theme on "Follow Outlook".
 */
async function shot(name, url, { before, width = 420, height = 900, colorScheme = "light", fullPage = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "en-GB", colorScheme, timezoneId: "Europe/Zurich" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  ! pageerror in ${name}:`, e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (/ERR_CERT|Failed to load resource|favicon|net::ERR_/.test(text)) return;
    console.error(`  ! console error in ${name}:`, text);
  });
  await page.goto(`${base}/${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid=header]", { timeout: 30_000 });
  if (before) await before(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
  console.log("saved", name);
  await ctx.close();
}

const ready = (page, testId, timeout = 30_000) => page.waitForSelector(`[data-testid=${testId}]`, { timeout });

await shot("summary", "taskpane.html?mock=1", { before: (p) => ready(p, "summary-tab") });

await shot("summary-fr", "taskpane.html?mock=1", {
  before: async (p) => {
    await ready(p, "summary-tab");
    await p.getByTestId("header").getByRole("button", { name: "FR", exact: true }).click();
    await p.waitForTimeout(1200);
    await ready(p, "summary-tab");
  },
});

await shot("thread", "taskpane.html?mock=1&view=thread", { before: (p) => ready(p, "thread-view") });

await shot("chat", "taskpane.html?mock=1&tab=chat", {
  before: async (p) => {
    await p.fill("input[placeholder]", "Find the email where the client approved the mandate.");
    await p.keyboard.press("Enter");
    await ready(p, "assistant-card");
  },
});

await shot("daily-brief", "taskpane.html?mock=1&view=brief", {
  before: async (p) => {
    await ready(p, "daily-brief");
    await ready(p, "brief-stats");
  },
});

// The pane reached from the "Apps" rail of the new Outlook / OWA: no mailbox,
// no sample email, no "Preview mode" pill — brief + chat over the mailbox.
await shot("home-tab", "taskpane.html?mock=1&view=home&host=tab", {
  before: async (p) => {
    await ready(p, "home-mode");
    await ready(p, "daily-brief");
    await ready(p, "sync-status");
  },
});

// Multi-select: three messages selected in the list (faked in preview mode).
await shot("selection", "taskpane.html?mock=1&preview=1&selection=3", {
  height: 560,
  before: async (p) => {
    await ready(p, "selection-view");
    await p.waitForSelector("[data-testid=selection-item]", { timeout: 30_000 });
  },
});

await shot("insights-automation", "taskpane.html?mock=1&tab=insights", {
  before: async (p) => {
    await ready(p, "sync-status");
    await ready(p, "automation-coach");
    await p.waitForSelector("[data-testid^=automation-auto]", { timeout: 30_000 });
    await p.click("button:has-text('Run simulation')");
    await ready(p, "simulation-results");
    await p.waitForTimeout(4500); // let the "Simulation completed" toast disappear
  },
});

await shot("compliance", "taskpane.html?mock=1&mode=compose", { before: (p) => ready(p, "compliance-headline") });

// Viewport-only: the drawer is position:fixed, so a full-page shot would crop it.
await shot("settings", "taskpane.html?mock=1", {
  fullPage: false,
  height: 1260,
  before: async (p) => {
    await ready(p, "summary-tab");
    await p.getByTestId("open-settings").click();
    await ready(p, "settings-sheet");
    await p.waitForTimeout(800); // let the health check resolve
  },
});

await shot("dark-mode", "taskpane.html?mock=1", {
  colorScheme: "dark",
  before: async (p) => {
    await ready(p, "summary-tab");
    await p.waitForFunction(() => document.documentElement.getAttribute("data-oao-theme") === "dark", { timeout: 10_000 });
  },
});

await shot("approval-dialog", "taskpane.html?mock=1", {
  before: async (p) => {
    await ready(p, "review-actions");
    await p.click("[data-testid=review-actions]");
    await ready(p, "approve-button");
  },
});

await shot("approval-dialog-wide", "taskpane.html?mock=1", {
  width: 640,
  before: async (p) => {
    await ready(p, "review-actions");
    await p.click("[data-testid=review-actions]");
    await ready(p, "approve-button");
  },
});

await shot("triage", "taskpane.html?mock=1&sample=newsletter", { height: 520, before: (p) => ready(p, "triage-card") });

await browser.close();
server?.kill();
