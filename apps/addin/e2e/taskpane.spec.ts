/**
 * End-to-end coverage of the surfaces a user actually touches, against the
 * built bundle in preview + mock mode.
 *
 * Each test starts from a clean storage state (`localStorage`, IndexedDB) so the
 * cache from a previous test cannot make an assertion pass by accident.
 */
import { expect, test, type Page } from "@playwright/test";

/**
 * Playwright gives every test its own browser context, so `localStorage` and
 * IndexedDB already start empty — no clearing needed, and a `page.reload()`
 * inside a test really does exercise the warm cache.
 */
async function freshPane(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("header")).toBeVisible();
}

/**
 * Console noise that says nothing about our code: office.js is fetched from the
 * Microsoft CDN, which is unreachable (or TLS-intercepted) in CI, and the
 * preview server has no favicon.
 */
const IGNORED_CONSOLE = [/ERR_CERT/, /Failed to load resource/, /appsforoffice/, /favicon/, /net::ERR_/];

test.describe("read pane", () => {
  test("summary renders the analysis with a source badge and no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(text);
    });

    await freshPane(page, "/taskpane.html?mock=1");

    const summary = page.getByTestId("summary-tab");
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Sarah Johnson is sharing the Q2 vendor risk assessment")).toBeVisible();

    // The sample email is precomputed by the mock worker, so the pane must not
    // have spent a model call — the badge proves it.
    const badge = page.getByTestId("source-badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-source", "precomputed");

    // The four mock-up cards plus the suggested actions.
    await expect(page.getByText("Decisions", { exact: true })).toBeVisible();
    await expect(page.getByText("Pending Tasks", { exact: true })).toBeVisible();
    await expect(page.getByText("Detected Risks", { exact: true })).toBeVisible();
    await expect(page.getByTestId("suggested-actions")).toBeVisible();
    await expect(page.getByTestId("confidence-value")).toHaveText("92%");

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("switching back to an analysed email is served from the local cache", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    await expect(page.getByTestId("summary-tab")).toBeVisible({ timeout: 30_000 });

    // Reload: the analysis is now in IndexedDB, so it must render from "local"
    // without going back to the backend.
    await page.reload({ waitUntil: "domcontentloaded" });
    const badge = page.getByTestId("source-badge").first();
    await expect(badge).toBeVisible({ timeout: 30_000 });
    await expect(badge).toHaveAttribute("data-source", "local");
  });

  test("chat answers with cited sources and evidence", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1&tab=chat");
    await page.getByRole("textbox").first().fill("Find the email where the client approved the mandate.");
    await page.keyboard.press("Enter");

    const card = page.getByTestId("assistant-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("Client approval detected")).toBeVisible();
    await expect(card.getByText("Re: Mandate Approval – ABC Capital").first()).toBeVisible();
    await expect(card.getByText("95%")).toBeVisible();
    await expect(card.getByText("78%")).toBeVisible();
    await expect(card.getByText("62%")).toBeVisible();
    await expect(card.getByText(/We confirm our approval of the mandate/)).toBeVisible();
  });

  test("the approval dialog approves 5 actions and reports the results", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    await page.getByTestId("review-actions").click();

    await expect(page.getByTestId("proposed-count")).toHaveText("5 proposed actions", { timeout: 30_000 });
    const approve = page.getByTestId("approve-button");
    await expect(approve).toHaveText("Approve selected actions (5)");
    await approve.click();

    const results = page.getByTestId("action-results");
    await expect(results).toBeVisible({ timeout: 30_000 });
    await expect(results.locator("> div")).toHaveCount(5, { timeout: 30_000 });
  });
});

test.describe("daily brief", () => {
  test("renders headline, priority emails, tasks, deadlines and stats", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1&view=brief");

    const brief = page.getByTestId("daily-brief");
    await expect(brief).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("brief-headline")).toContainText("3 items need you today");
    await expect(page.getByTestId("brief-highlights")).toContainText("signed Account Mandate");
    await expect(page.getByTestId("brief-email")).toHaveCount(3);
    await expect(page.getByTestId("brief-tasks")).toContainText("Obtain the signed Account Mandate");
    await expect(page.getByTestId("brief-deadlines")).toContainText("Target onboarding date");
    await expect(page.getByTestId("brief-alerts")).toContainText("suspicious inbound email");
    await expect(page.getByTestId("brief-stats")).toContainText("42");
    await expect(page.getByTestId("source-badge").first()).toHaveAttribute("data-source", /precomputed|local/);
  });

  test("regenerating asks for confirmation because it costs a model call", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1&view=brief");
    await expect(page.getByTestId("daily-brief")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("brief-regenerate").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("costs one");

    await page.getByTestId("brief-regenerate-confirm").click();
    await expect(page.getByTestId("source-badge").first()).toHaveAttribute("data-source", "llm", { timeout: 30_000 });
  });
});

test.describe("compose", () => {
  test("Compliance Guardian shows the 4 issues from the mock-up", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1&mode=compose");

    await expect(page.getByTestId("compliance-headline")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("compliance-headline")).toContainText("4 compliance issues detected");

    const issues = page.getByTestId("compliance-issue");
    await expect(issues).toHaveCount(4);
    await expect(issues.nth(0)).toHaveAttribute("data-severity", "high");
    await expect(issues.nth(2)).toHaveAttribute("data-severity", "medium");
    await expect(page.getByText("External recipient detected")).toBeVisible();
    await expect(page.getByText("Missing classification label")).toBeVisible();
  });
});

test.describe("localisation, theme and accessibility", () => {
  test("the FR toggle translates the whole pane and persists", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    await expect(page.getByTestId("summary-tab")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("header").getByRole("button", { name: "FR", exact: true }).click();
    await expect(page.getByText("Résumé", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Décisions", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("Décisions", { exact: true })).toBeVisible({ timeout: 30_000 });
  });

  test("settings switches to the dark theme and clears the cache", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    await page.getByTestId("open-settings").click();

    const sheet = page.getByTestId("settings-sheet");
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByTestId("settings-backend")).toContainText("http");

    await sheet.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-oao-theme", "dark");

    await sheet.getByTestId("settings-clear-cache").click();
    // The confirmation lands in the toast *and* in the assertive aria-live
    // region, so match the first of the two rather than racing them.
    await expect(page.getByText("Local cache cleared.").first()).toBeVisible();
  });

  test("the pane is usable at 320 px and never scrolls horizontally", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await freshPane(page, "/taskpane.html?mock=1");
    await expect(page.getByTestId("summary-tab")).toBeVisible({ timeout: 30_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("landmarks, a skip link and a labelled tab list are present", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator("main#oao-main")).toBeVisible();
    await expect(page.locator("nav[aria-label='Sections']")).toBeVisible();
    await expect(page.locator("#oao-skip")).toHaveAttribute("href", "#oao-main");
    await expect(page.getByRole("tab", { name: "Summary" })).toBeVisible();
  });

  test("a strict CSP meta tag is shipped with the page", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1");
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(policy).toBeTruthy();
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("script-src 'self' https://appsforoffice.microsoft.com");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("unsafe-eval");
    // frame-ancestors is header-only; shipping it in a meta tag only logs a warning.
    expect(policy).not.toContain("frame-ancestors");
  });
});

test.describe("home mode (new Outlook / OWA Apps rail)", () => {
  test("?view=home&host=tab renders the brief and the mailbox chat, with no sample email", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(text);
    });

    await freshPane(page, "/taskpane.html?mock=1&view=home&host=tab");

    // The personal tab has no mailbox, but it is *not* preview mode: the pane
    // talks to the real backend and must not show the sample email.
    await expect(page.getByTestId("home-mode")).toBeVisible();
    await expect(page.getByTestId("preview-pill")).toHaveCount(0);
    await expect(page.getByTestId("summary-tab")).toHaveCount(0);
    await expect(page.getByTestId("tab-summary")).toHaveCount(0);
    await expect(page.getByTestId("home-hint")).toContainText("Open an email to analyse it");

    // Daily brief + sync status = everything that is mailbox-wide.
    await expect(page.getByTestId("daily-brief")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("brief-headline")).toContainText("3 items need you today");
    await expect(page.getByTestId("sync-status")).toBeVisible({ timeout: 30_000 });

    // The chat works with no item at all, scoped to the indexed mailbox.
    await page.getByTestId("tab-chat").click();
    await expect(page.getByTestId("chat-tab")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "This conversation" })).toHaveCount(0);
    await page.getByRole("textbox").first().fill("What am I still waiting for?");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("assistant-card")).toBeVisible({ timeout: 30_000 });

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });
});

test.describe("selection (multi-select)", () => {
  test("lists the selected emails and synthesises them on demand", async ({ page }) => {
    await freshPane(page, "/taskpane.html?mock=1&preview=1&selection=3");

    const view = page.getByTestId("selection-view");
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("selection-item")).toHaveCount(3);
    // Listing a selection costs nothing: no synthesis until it is asked for.
    await expect(page.getByTestId("thread-view")).toHaveCount(0);

    await page.getByTestId("selection-synthesise").click();
    await expect(page.getByTestId("thread-view")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("missing-document").first()).toBeVisible();

    await page.getByTestId("selection-back").click();
    await expect(page.getByTestId("selection-view")).toBeVisible();

    // The scoped chat is reachable and labels its scope.
    await page.getByTestId("selection-ask").click();
    await expect(page.getByTestId("chat-fixed-scope")).toContainText("This selection (3)");
  });
});

/**
 * These two describe the pane's behaviour when the orchestrator is **not**
 * there. The suite now starts a real orchestrator for `sim.spec.ts`, so "not
 * there" has to be stated rather than assumed: the backend origin is blocked at
 * the network layer, which is also what makes these tests deterministic on a
 * developer machine that happens to be running `pnpm dev`.
 */
const API_ORIGIN = process.env.E2E_API_URL ?? "http://localhost:8080";

async function blockBackend(page: Page): Promise<void> {
  await page.route(`${API_ORIGIN}/**`, (route) => route.abort("connectionrefused"));
}

test.describe("backend unreachable", () => {
  test("blocks with the base URL and a retry instead of silently showing sample data", async ({ page }) => {
    // No `?mock=1` and not preview mode (host=tab) → the live client is kept and
    // the failed health check must be shown, never replaced by the sample email.
    await blockBackend(page);
    await freshPane(page, "/taskpane.html?view=home&host=tab");

    const card = page.getByTestId("backend-unreachable");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("backend-unreachable-url")).toContainText("http");
    await expect(card).toContainText("VITE_API_BASE_URL");
    await expect(page.getByTestId("backend-retry")).toBeVisible();
    await expect(page.getByTestId("backend-unreachable-detail")).toContainText(/unreachable|timed out|Unexpected/i);

    // Nothing from the mock / sample data leaked through.
    await expect(page.getByTestId("daily-brief")).toHaveCount(0);
    await expect(page.getByTestId("summary-tab")).toHaveCount(0);
    await expect(page.getByTestId("mock-pill")).toHaveCount(0);
    await expect(page.getByTestId("preview-pill")).toHaveCount(0);
  });

  test("preview mode still falls back to the mock, and says so with both pills", async ({ page }) => {
    await blockBackend(page);
    await freshPane(page, "/taskpane.html");
    await expect(page.getByTestId("preview-pill")).toBeVisible();
    await expect(page.getByTestId("mock-pill")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("summary-tab")).toBeVisible({ timeout: 30_000 });
  });
});
