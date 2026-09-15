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
    await expect(page.getByText("Local cache cleared.")).toBeVisible();
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
