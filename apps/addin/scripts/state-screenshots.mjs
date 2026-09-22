/**
 * `node scripts/state-screenshots.mjs`
 *
 * Every screen state of the task pane, captured through the **Office.js host
 * simulator** (`e2e/office-sim/`) against a **real orchestrator**, into
 * `docs/screenshots/states/`.
 *
 * Nothing here is mocked in the pane: the add-in runs its production bundle,
 * talks to the orchestrator over HTTP and reads its item from the simulated
 * host. The three states that need a broken backend are produced by breaking
 * the backend, not by faking a payload:
 *
 *   - `degraded`    → requests are forwarded to a second orchestrator whose LLM
 *                     endpoint does not exist, so it really answers
 *                     `source: heuristic` + `ai_output_unreliable`
 *   - `unreachable` → the orchestrator origin is blocked at the network layer
 *   - `http-error`  → the analyse route answers 500 with a correlation id
 *
 * The pane must have been built with `ADDIN_SIM=1` (that is what emits
 * `sim.html`); `npm run e2e -w @oao/addin` does it, or build it directly:
 * `ADDIN_SIM=1 VITE_API_BASE_URL=http://localhost:8080 npm run build -w @oao/addin`.
 *
 * Env:
 *   E2E_BASE_URL        pane origin              (default http://localhost:4173)
 *   OAO_API_URL         orchestrator            (default http://localhost:8080)
 *   OAO_DEGRADED_URL    orchestrator with a dead model (default …:8081)
 *   PW_CHROMIUM_PATH    chromium executable     (default /opt/pw-browsers/chromium)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "docs", "screenshots", "states");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4173";
const API = process.env.OAO_API_URL ?? "http://localhost:8080";
const DEGRADED = process.env.OAO_DEGRADED_URL ?? "http://localhost:8081";
const PANE = { width: 420, height: 900 };

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let coldSeq = 0;
/** A mailbox address nobody has analysed yet: forces a real model call. */
const coldUser = () => `sim-${Date.now().toString(36)}-${++coldSeq}@northbridge.example`;

/**
 * One fresh pane (own storage, own routes) per state.
 *
 * The simulated host reports `displayLanguage: "fr-FR"` (the user is French),
 * so the language is pinned through the same `localStorage` key the FR/EN toggle
 * writes — English here, so one reviewer can read every state side by side. The
 * French rendering is covered by the e2e spec.
 */
async function pane({ routes, user, lang = "en" } = {}) {
  const ctx = await browser.newContext({ viewport: PANE, locale: "en-GB", timezoneId: "Europe/Zurich", deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem("oao.addin.language", l);
    } catch (e) {
      /* ignore */
    }
  }, lang);
  // office.js is never loaded on the simulator page, but block the CDN anyway so
  // a slow DNS lookup cannot delay a capture.
  await page.route("**/appsforoffice.microsoft.com/**", (r) => r.abort());
  if (routes) await routes(page);
  const query = user ? `?bar=0&user=${encodeURIComponent(user)}` : "?bar=0";
  await page.goto(`${BASE}/sim.html${query}`, { waitUntil: "domcontentloaded" });
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(350); // let Fluent settle its transitions
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}.png`);
}

const sim = (page, fn, ...args) => page.evaluate(fn, ...args);

/* ------------------------------------------------------------------ */

async function capture(name, { routes, run, user, lang }) {
  const { ctx, page } = await pane({ routes, user, lang });
  try {
    await run(page);
    await shot(page, name);
  } finally {
    await ctx.close();
  }
}

const waitSummary = (page) => page.waitForSelector('[data-testid="summary-card"]', { timeout: 40_000 });
const waitAny = (page, selector) => page.waitForSelector(selector, { timeout: 40_000 });

console.log("capturing pane states →", OUT);

/* 1. loading: the host is slow, so the skeleton names the email it is analysing */
await capture("loading", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.setLatency(4000));
    await sim(page, () => window.__oaoSim.openItem("B"));
    await waitAny(page, '[data-testid="skeleton-label"]');
  },
});

/* 2. success from the model — a mailbox the orchestrator has never seen, so the
      answer cannot come from its content cache */
await capture("success-llm", {
  user: coldUser(),
  run: async (page) => {
    await waitSummary(page);
    await waitAny(page, '[data-source="llm"]');
  },
});

/* 3. success from this device's cache (the same email, opened again) */
await capture("success-cache", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.openItem("B"));
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.openItem("A"));
    await waitAny(page, '[data-source="local"]');
  },
});

/* 4. rules only: a newsletter the orchestrator triaged, with "Analyse anyway" */
await capture("rules-only", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.openItem("C"));
    await waitAny(page, '[data-testid="triage-card"]');
  },
});

/* 5. degraded: a real orchestrator whose model endpoint is dead */
await capture("degraded", {
  user: coldUser(),
  routes: async (page) => {
    await page.route(`${API}/api/v1/**`, async (route) => {
      const url = route.request().url().replace(API, DEGRADED);
      const response = await route.fetch({ url }).catch(() => null);
      if (!response) return route.abort();
      return route.fulfill({ response });
    });
  },
  run: async (page) => {
    await waitAny(page, '[data-testid="degraded-banner"]');
  },
});

/* 6. the orchestrator cannot be reached at all */
await capture("unreachable", {
  routes: async (page) => {
    await page.route(`${API}/**`, (route) => route.abort("connectionrefused"));
  },
  run: async (page) => {
    await waitAny(page, '[data-testid="backend-unreachable"]');
  },
});

/* 7. one endpoint answers 500: inline error, correlation id, Retry */
await capture("http-error", {
  routes: async (page) => {
    await page.route(`${API}/api/v1/analyze/email`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Analysis failed (simulated backend fault)", correlationId: "c0rr-3l4t10n-1d-0042" } }),
      }),
    );
  },
  run: async (page) => {
    await waitAny(page, '[data-testid="error-state"]');
  },
});

/* 8. a real conversation with nothing to decide, nothing to do, no risk */
await capture("empty-sections", {
  user: coldUser(),
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.openItem("G"));
    await waitSummary(page);
    await waitAny(page, "text=No decision identified.");
  },
});

/* 9. nothing selected: the mailbox-wide home surface */
await capture("home-no-item", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.closeItem());
    await waitAny(page, '[data-testid="home-mode"]');
    await page.waitForTimeout(1500);
  },
});

/* 10. several messages selected in the list */
await capture("selection", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.select(["A", "B", "F"]));
    await waitAny(page, '[data-testid="selection-view"]');
  },
});

/* 11-13. compose: loading, issues, clean */
await capture("compose-loading", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.setLatency(4000));
    await sim(page, () => window.__oaoSim.compose("issues"));
    await waitAny(page, '[data-testid="skeleton"]');
  },
});

await capture("compose-issues", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.compose("issues"));
    await waitAny(page, '[data-testid="compliance-headline"]');
  },
});

await capture("compose-clean", {
  run: async (page) => {
    await waitSummary(page);
    await sim(page, () => window.__oaoSim.compose("clean"));
    await waitAny(page, '[data-testid="compliance-headline"]');
  },
});

await browser.close();
console.log("done");
