import { expect, test } from "@playwright/test";

test.describe("policy center", () => {
  test("an invalid regular expression blocks the save with an inline error", async ({ page }) => {
    await page.goto("/policy");
    await expect(page.getByRole("heading", { name: "Policy Center" })).toBeVisible();

    const firstPattern = page.getByLabel("Regex 1");
    await expect(firstPattern).toBeVisible();
    await firstPattern.fill("[A-Z");

    await expect(page.locator("#pattern-check-0")).toContainText("Invalid regular expression");
    await expect(page.getByRole("button", { name: "Save policy" })).toBeDisabled();

    // A valid pattern re-enables the save.
    await firstPattern.fill("\\b[A-Z]{2}\\d{2}[A-Z0-9]{10,28}\\b");
    await expect(page.locator("#pattern-check-0")).toContainText("Valid");
    await expect(page.getByRole("button", { name: "Save policy" })).toBeEnabled();
  });

  test("saving records the new version with updated by / at", async ({ page }) => {
    await page.goto("/policy");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Policy saved" })).toBeVisible();
    await expect(page.getByTestId("policy-version")).toContainText("Updated by");
    await expect(page.getByTestId("policy-version")).toContainText("admin@northbridge.example");
  });

  test("the rule test panel previews which rules would fire", async ({ page }) => {
    await page.goto("/policy");
    const panel = page.getByTestId("policy-test-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Preview", { exact: true })).toBeVisible();

    await panel
      .getByLabel("Sample text")
      .fill("CONFIDENTIAL — please wire to IBAN CH9300762011623852957 today.");
    await panel
      .getByLabel("Recipients")
      .fill("client@abccapital.example\ncolleague@northbridge.example");
    await panel.getByTestId("policy-test-run").click();

    const results = page.getByTestId("policy-test-results");
    await expect(results).toBeVisible();
    await expect(results).toContainText("IBAN");
    await expect(results).toContainText("External recipient");
    await expect(results).toContainText("client@abccapital.example");
    await expect(results).not.toContainText("colleague@northbridge.example");
  });
});
