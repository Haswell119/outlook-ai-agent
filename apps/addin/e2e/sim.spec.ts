/**
 * End-to-end tests driven by the **Office.js host simulator**, against the
 * **real orchestrator** (`LLM_PROVIDER=mock`, in-memory database) started by
 * Playwright's `webServer`.
 *
 * What makes these different from `taskpane.spec.ts`: nothing is mocked in the
 * pane. `taskpane.html` — the exact file Outlook loads — runs its production
 * bundle, the simulator is injected before it with `page.addInitScript` (as
 * Outlook injects office.js), and every answer on screen came over HTTP from
 * the orchestrator. That is the only setup in which "I opened an email, closed
 * it, opened another one and the pane is stuck on the previous one" can be
 * reproduced, and therefore the only one in which it can be proven fixed.
 *
 * The simulator's own page (`/sim.html`, with the control bar) is exercised
 * once, at the end: it is what a developer uses by hand.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SIM_FILES = ["fixtures.js", "office-sim.js"].map((f) => join(here, "office-sim", f));
const API = process.env.E2E_API_URL ?? "http://localhost:8080";

/** Console noise that says nothing about our code. */
const IGNORED_CONSOLE = [/ERR_CERT/, /Failed to load resource/, /appsforoffice/, /favicon/, /net::ERR_/];

let coldSeq = 0;
/**
 * A mailbox the orchestrator has never analysed, so its content cache cannot
 * answer and the model really is called (`source: "llm"`). Anything else would
 * assert "the cache works", not "the model is used".
 */
const coldUser = () => `e2e-${Date.now().toString(36)}-${++coldSeq}@northbridge.example`;

export interface SimOptions {
  /** Mailbox address the simulated host reports (see `coldUser`). */
  user?: string;
  /** Pin the pane's language instead of following the host's `fr-FR`. */
  lang?: "fr" | "en";
  /** Page to open (the production task pane by default). */
  path?: string;
}

/**
 * Inject the simulator, then open the pane.
 *
 * `taskpane.html` asks the Microsoft CDN for office.js; that request is aborted
 * so the real office.js can never overwrite the simulated one (and so the test
 * does not wait for a CDN it cannot reach).
 */
async function openPane(page: Page, opts: SimOptions = {}): Promise<void> {
  await page.route("**/appsforoffice.microsoft.com/**", (route) => route.abort());
  for (const path of SIM_FILES) {
    if (!existsSync(path)) throw new Error(`simulator file missing: ${path}`);
    await page.addInitScript({ path });
  }
  if (opts.lang) {
    await page.addInitScript((l) => {
      try {
        window.localStorage.setItem("oao.addin.language", l);
      } catch {
        /* ignore */
      }
    }, opts.lang);
  }
  const query = new URLSearchParams();
  if (opts.user) query.set("user", opts.user);
  const url = `${opts.path ?? "/taskpane.html"}${query.toString() ? `?${query}` : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("header")).toBeVisible();
  // The simulator must be the host the pane sees.
  expect(await page.evaluate(() => !!window.__oaoSimInstalled)).toBe(true);
}

/**
 * The host controls (`window.__oaoSim`), as a small typed façade so a test reads
 * like what a user does: `host(page).open("B")`.
 */
interface OaoSimControls {
  openItem: (key: string, opts?: { silent?: boolean }) => string;
  closeItem: () => void;
  reloadPane: () => void;
  select: (keys: string[]) => void;
  compose: (draft: string) => void;
  setLatency: (ms: number) => number;
  failNext: (api: string) => void;
  state: () => { surface: string; itemKey: string | null; subject: string | null; handlers: { ItemChanged: number; SelectedItemsChanged: number } };
  calls: (filter?: string) => string[];
}

declare global {
  interface Window {
    __oaoSim: OaoSimControls;
    __oaoSimInstalled?: boolean;
  }
}

const host = (page: Page) => ({
  open: (key: string, opts: { silent?: boolean } = {}) => page.evaluate(([k, o]) => window.__oaoSim.openItem(k as string, o as { silent?: boolean }), [key, opts] as const),
  close: () => page.evaluate(() => window.__oaoSim.closeItem()),
  reload: () => page.evaluate(() => window.__oaoSim.reloadPane()),
  select: (keys: string[]) => page.evaluate((k) => window.__oaoSim.select(k), keys),
  compose: (draft: string) => page.evaluate((d) => window.__oaoSim.compose(d), draft),
  latency: (ms: number) => page.evaluate((m) => window.__oaoSim.setLatency(m), ms),
  state: () => page.evaluate(() => window.__oaoSim.state()),
  calls: (filter?: string) => page.evaluate((f) => window.__oaoSim.calls(f), filter),
});

const summary = (page: Page) => page.getByTestId("summary-card");
const subjectLine = (page: Page) => page.getByTestId("item-subject");
const badge = (page: Page) => page.getByTestId("source-badge").first();

/* ------------------------------------------------------------------------- */

test.describe("switching between messages (the pinned pane)", () => {
  test("A → B → close → B after a pane reload never shows the previous email", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);

    // A is open when the pane starts.
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(subjectLine(page)).toContainText("Atlas project — open points");

    // The host is slow, which is when the stale-pane bug used to be visible:
    // for as long as `body.getAsync` took, the pane showed A's analysis.
    await h.latency(1200);
    await h.open("B");
    await expect(page.getByTestId("skeleton")).toBeVisible();
    await expect(subjectLine(page)).toContainText("relevé trimestriel");
    await expect(page.getByText("Atlas project — open points", { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("summary-tab")).toHaveCount(0);

    // …and the progress text names what is happening.
    await expect(page.getByTestId("skeleton-label")).toContainText("Analysing");

    await h.latency(0);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(summary(page)).toContainText("relevé trimestriel");

    // Closing the message: no item, so the mailbox-wide surface — never A or B.
    await h.close();
    await expect(page.getByTestId("home-mode")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("summary-tab")).toHaveCount(0);

    // Re-opening B and then letting Outlook re-create the pane iframe: still B.
    await h.open("B");
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await h.reload();
    await expect(page.getByTestId("header")).toBeVisible();
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(subjectLine(page)).toContainText("relevé trimestriel");
    await expect(summary(page)).not.toContainText("open points");
  });

  test("an item swapped without ItemChanged is recovered when the pane is focused", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    // The pane registers its handler even when it is not pinned…
    expect((await h.state()).handlers.ItemChanged).toBe(1);

    // …but the host can still move on without raising it (no Mailbox 1.5, or a
    // pane that was hidden while the user clicked another message).
    await h.open("F", { silent: true });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(subjectLine(page)).toContainText("coordonnées de règlement", { timeout: 40_000 });
    await expect(summary(page)).toBeVisible();
    await expect(summary(page)).not.toContainText("open points");
  });

  test("leaving an email mid-analysis cancels it instead of landing on the next one", async ({ page }) => {
    // The analyse route is held open long enough for the user to move on.
    let held = 0;
    await page.route(`${API}/api/v1/analyze/email`, async (route) => {
      held++;
      await new Promise((r) => setTimeout(r, 4_000));
      // The pane aborts the request while we hold it, which makes `continue()`
      // throw — that is the behaviour under test, not a failure.
      await route.continue().catch(() => undefined);
    });
    await openPane(page, { lang: "en", user: coldUser() });
    const h = host(page);

    await expect(page.getByTestId("skeleton")).toBeVisible({ timeout: 20_000 });
    await h.open("G");
    // A's slow answer must never be painted over G.
    await expect(subjectLine(page)).toContainText("salle réservée");
    await page.waitForTimeout(6_000);
    await expect(subjectLine(page)).toContainText("salle réservée");
    await expect(page.getByText("open points", { exact: false })).toHaveCount(0);
    expect(held).toBeGreaterThan(0);
  });
});

test.describe("what the model is asked, and what it answers", () => {
  test("a normal conversation email is analysed by the model and says so", async ({ page }) => {
    await openPane(page, { lang: "en", user: coldUser() });
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(badge(page)).toHaveAttribute("data-source", "llm");
    await expect(page.getByTestId("summary-tab")).toBeVisible();
    await expect(page.getByTestId("summary-tab")).toHaveAttribute("data-degraded", "false");
  });

  test("a forwarded email whose body starts with a quote header is not empty", async ({ page }) => {
    await openPane(page, { lang: "fr", user: coldUser() });
    const h = host(page);
    await h.open("B");

    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("empty-analysis")).toHaveCount(0);

    // The summary has real content, and the quoted `De : … <address>` header is
    // not swallowed by the HTML reduction any more.
    const text = (await summary(page).innerText()).trim();
    expect(text.length).toBeGreaterThan(80);
    expect(text).toContain("Atlas");
    expect(text).toContain("compta@atlas-partners.example");
    await expect(badge(page)).toHaveAttribute("data-source", /llm|cache|precomputed/);
  });

  test("a newsletter stops at the rules, and Analyse anyway is honest about it", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);
    await h.open("C");

    const card = page.getByTestId("triage-card");
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(card).toHaveAttribute("data-kind", "newsletter");
    await expect(badge(page)).toHaveAttribute("data-source", "heuristic");
    await expect(page.getByTestId("summary-card")).toHaveCount(0);

    // The escape hatch exists, and when the orchestrator triages the email again
    // the pane says so instead of redrawing the same card in silence.
    await page.getByTestId("analyse-anyway").click();
    await expect(page.getByTestId("triage-still-triaged")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("analyse-anyway")).toBeDisabled();
  });

  test("an out-of-office and a two-word acknowledgement are triaged too", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);

    await h.open("D");
    await expect(page.getByTestId("triage-card")).toHaveAttribute("data-kind", "out_of_office", { timeout: 40_000 });

    await h.open("E");
    await expect(page.getByTestId("triage-card")).toHaveAttribute("data-kind", "trivial", { timeout: 40_000 });
  });

  test("an email with nothing to act on says so, line by line", async ({ page }) => {
    await openPane(page, { lang: "en", user: coldUser() });
    const h = host(page);
    await h.open("G");

    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText("No decision identified.")).toBeVisible();
    await expect(page.getByText("No pending task.")).toBeVisible();
    await expect(page.getByText("No risk detected.")).toBeVisible();
  });

  test("re-opening an analysed email is served from this device, with no request", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await h.open("B");
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/analyze")) requests.push(r.url());
    });
    await h.open("A");
    await expect(badge(page)).toHaveAttribute("data-source", "local", { timeout: 40_000 });
    expect(requests, `unexpected analyse requests: ${requests.join(", ")}`).toEqual([]);
  });
});

test.describe("when the backend is not there", () => {
  test("the pane blocks, and Retry works once the orchestrator is back", async ({ page }) => {
    let down = true;
    await page.route(`${API}/**`, async (route) => {
      if (down) return route.abort("connectionrefused");
      return route.continue();
    });

    await openPane(page, { lang: "en" });
    const card = page.getByTestId("backend-unreachable");
    await expect(card).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("backend-unreachable-url")).toContainText("8080");
    // No sample data leaked in as a consolation prize.
    await expect(page.getByTestId("summary-tab")).toHaveCount(0);
    await expect(page.getByTestId("mock-pill")).toHaveCount(0);

    down = false;
    await page.getByTestId("backend-retry").click();
    await expect(card).toHaveCount(0, { timeout: 40_000 });
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
  });

  test("a 500 from the analyse route is shown inline with its correlation id and a Retry", async ({ page }) => {
    let failing = true;
    await page.route(`${API}/api/v1/analyze/email`, async (route) => {
      if (!failing) return route.continue();
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Analysis failed", correlationId: "corr-e2e-500" } }),
      });
    });

    await openPane(page, { lang: "en", user: coldUser() });
    const error = page.getByTestId("error-state");
    await expect(error).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("error-correlation")).toContainText("corr-e2e-500");
    // The pane still says which email failed.
    await expect(subjectLine(page)).toContainText("Atlas project");

    failing = false;
    await page.getByTestId("error-retry").click();
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
  });

  test("a model that is down degrades to rules and warns, with a Retry", async ({ page }) => {
    // The orchestrator's own degraded answer: `source: heuristic` plus the
    // `ai_output_unreliable` risk. It is produced here by making the analyse
    // route answer exactly what an orchestrator with an unreachable model
    // answers, so the pane is tested against the real contract.
    await page.route(`${API}/api/v1/analyze/email`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        source?: string;
        confidence: number;
        risks: Array<{ code: string; title: string; severity: string; description?: string }>;
      };
      body.source = "heuristic";
      body.confidence = 0.3;
      body.risks = [
        ...body.risks,
        { code: "ai_output_unreliable", title: "Degraded AI analysis (heuristics only)", severity: "medium", description: "network: LLM request failed" },
      ];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await openPane(page, { lang: "en", user: coldUser() });
    await expect(page.getByTestId("degraded-banner")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("degraded-banner")).toContainText("AI unavailable");
    await expect(badge(page)).toHaveAttribute("data-source", "heuristic");
    await expect(page.getByTestId("summary-tab")).toHaveAttribute("data-degraded", "true");
    await expect(page.getByTestId("degraded-retry")).toBeEnabled();
  });
});

test.describe("the other surfaces", () => {
  test("three selected messages are listed, and synthesised only on demand", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    await h.select(["A", "B", "F"]);
    await expect(page.getByTestId("selection-view")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId("selection-item")).toHaveCount(3);
    await expect(page.getByTestId("thread-view")).toHaveCount(0);

    await page.getByTestId("selection-synthesise").click();
    await expect(page.getByTestId("thread-view")).toBeVisible({ timeout: 60_000 });
  });

  test("compose: the draft with client data is flagged, a labelled internal draft is clean", async ({ page }) => {
    await openPane(page, { lang: "en" });
    const h = host(page);
    await h.compose("issues");

    await expect(page.getByTestId("compliance-headline")).toBeVisible({ timeout: 40_000 });
    const issues = page.getByTestId("compliance-issue");
    expect(await issues.count()).toBeGreaterThan(0);
    await expect(page.getByText("External recipient detected")).toBeVisible();

    // The clean draft carries a sensitivity label, which the pane now reads —
    // without it every draft was reported as "Missing classification label".
    await h.compose("clean");
    await expect(page.getByTestId("compliance-headline")).toContainText("No issues detected", { timeout: 40_000 });
    await expect(page.getByTestId("compliance-issue")).toHaveCount(0);
  });

  test("the Chat and Insights tabs keep their own loading, empty and answer states", async ({ page }) => {
    await openPane(page, { lang: "en" });
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    await page.getByTestId("tab-insights").click();
    await expect(page.getByTestId("insights-tab")).toBeVisible({ timeout: 40_000 });

    await page.getByTestId("tab-chat").click();
    await expect(page.getByTestId("chat-tab")).toBeVisible({ timeout: 40_000 });
    await page.getByRole("textbox").first().fill("What is still open on the Atlas project?");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-card")).toBeVisible({ timeout: 60_000 });
  });

  test("'All emails' answers from the emails browsed earlier, not from the one that is open (no Graph)", async ({ page }) => {
    // A fresh mailbox: nothing indexed, no Graph. Opening A then B analyses
    // both, and every analysed email is indexed by the orchestrator itself.
    await openPane(page, { lang: "en", user: coldUser() });
    const h = host(page);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await h.open("B");
    await expect(subjectLine(page)).toContainText("relevé trimestriel");
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    await page.getByTestId("tab-chat").click();
    await expect(page.getByTestId("chat-tab")).toBeVisible({ timeout: 40_000 });
    // B is open, so the default scope is its conversation: no mailbox status yet.
    await expect(page.getByTestId("chat-index-status")).toHaveCount(0);
    await page.getByRole("button", { name: "All emails" }).click();
    const status = page.getByTestId("chat-index-status");
    await expect(status).toContainText("2 emails indexed", { timeout: 20_000 });
    await expect(status).toContainText("without Microsoft Graph");

    // A question about A, asked while B is open.
    await page.getByRole("textbox").first().fill("What are the open points before the go-live and the cutover plan?");
    await page.keyboard.press("Enter");
    const card = page.getByTestId("assistant-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText("open points before the 30 September go-live");
    await expect(page.getByTestId("chat-retrieval")).toContainText("among 2 indexed");
    // The top source and the quoted evidence are A's, not the open email's
    // (B may legitimately appear further down: it is indexed too).
    await expect(card.getByRole("button").first()).toContainText("open points before the 30 September go-live");
    await expect(card).toContainText("Email: Re: Atlas project — open points");
  });
});

test.describe("language", () => {
  test("the host's display language is followed, and the toggle switches the whole pane", async ({ page }) => {
    // The simulated host reports `fr-FR`, as an Outlook in French does.
    await openPane(page);
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText("Résumé", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Décisions", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");

    await page.getByTestId("header").getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByText("Decisions", { exact: true })).toBeVisible({ timeout: 40_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // The analysis was re-resolved in English, not served from the French entry.
    await expect(summary(page)).toContainText("writes regarding");
  });
});

test.describe("the simulator page itself", () => {
  test("/sim.html exposes the host controls as buttons and drives the pane", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(text);
    });

    await page.route("**/appsforoffice.microsoft.com/**", (route) => route.abort());
    await page.goto("/sim.html", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#oao-sim-bar")).toBeVisible();
    await expect(summary(page)).toBeVisible({ timeout: 40_000 });

    await page.getByTestId("sim-open-C").click();
    await expect(page.getByTestId("triage-card")).toBeVisible({ timeout: 40_000 });

    await page.getByTestId("sim-close").click();
    await expect(page.getByTestId("home-mode")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("sim-select-3").click();
    await expect(page.getByTestId("selection-item")).toHaveCount(3, { timeout: 40_000 });

    await page.getByTestId("sim-compose-issues").click();
    await expect(page.getByTestId("compliance-headline")).toBeVisible({ timeout: 40_000 });

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
