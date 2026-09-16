import { expect, test } from "@playwright/test";

test.describe("overview", () => {
  test("renders the six KPI tiles, the charts and the audit log", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Audit & Supervision" })).toBeVisible();

    const tiles = page.getByTestId("kpi-tile");
    await expect(tiles).toHaveCount(6);
    await expect(tiles.filter({ hasText: "Emails summarized" }).getByTestId("kpi-value")).toHaveText(
      "8,642",
    );
    await expect(tiles.filter({ hasText: "Drafts generated" }).getByTestId("kpi-value")).toHaveText(
      "2,341",
    );
    await expect(
      tiles.filter({ hasText: "Compliance alerts" }).getByTestId("kpi-value"),
    ).toHaveText("37");

    // Charts and the audit table below them.
    await expect(page.getByText("AI activity over time")).toBeVisible();
    await expect(page.getByText("Actions by type")).toBeVisible();
    const rows = page.locator("table tbody tr");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(5);
  });

  test("the mock-data pill and the organisation name come from the contract", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Mock data")).toBeVisible();
    await expect(page.getByText("Northbridge Capital").first()).toBeVisible();
  });

  test("an audit row deep-links to its event page", async ({ page }) => {
    await page.goto("/audit");
    const firstLink = page.locator('a[href^="/audit/aud-"]').first();
    const href = await firstLink.getAttribute("href");
    await firstLink.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole("heading", { name: "Audit event" })).toBeVisible();
    await expect(page.getByText("Integrity hashes")).toBeVisible();
    await expect(page.getByText("Related events")).toBeVisible();
    await expect(page.getByText("Correlation id").first()).toBeVisible();
  });

  test("the language toggle switches every visible string to French", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "fr", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Audit & supervision" })).toBeVisible();
    await expect(page.getByText("E-mails résumés")).toBeVisible();
    await page.getByRole("button", { name: "en", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Audit & Supervision" })).toBeVisible();
  });
});
