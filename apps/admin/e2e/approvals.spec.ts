import { expect, test } from "@playwright/test";

test.describe("approvals decision flow", () => {
  test("a rejection requires a comment and updates the card", async ({ page }) => {
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();

    // The mock store is mutated by the decisions below, so a repeated run
    // against the same server process has nothing left to decide.
    const card = page.getByTestId("escalation-card").filter({ hasText: "Pending" }).first();
    test.skip((await card.count()) === 0, "no pending escalation left in the mock store");
    await expect(card).toBeVisible();

    // The draft under review comes from the contract (`Escalation.draft`).
    await expect(card.getByText("Draft under review")).toBeVisible();
    await expect(card.getByText(/Draft recipients \(\d+\)/)).toBeVisible();
    await expect(card.getByText(/Attachments \(\d+\)/)).toBeVisible();

    await card.getByRole("button", { name: "Reject", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Confirming without a justification is refused client-side.
    await dialog.getByRole("button", { name: "Confirm decision" }).click();
    await expect(dialog.getByRole("alert")).toContainText("comment is required");

    await dialog.getByLabel(/Comment/).fill("Rejected: external distribution without a label.");
    await dialog.getByRole("button", { name: "Confirm decision" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Escalation rejected" })).toBeVisible();

    // The decision is persisted: it shows up under "Decided".
    await page.getByRole("tab", { name: /Decided/ }).click();
    await expect(
      page.getByTestId("escalation-card").filter({ hasText: "Rejected" }).first(),
    ).toBeVisible();
  });

  test("an approval goes through without a comment", async ({ page }) => {
    await page.goto("/approvals");
    const card = page.getByTestId("escalation-card").filter({ hasText: "Pending" }).first();
    test.skip((await card.count()) === 0, "no pending escalation left in the mock store");
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Approve", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Confirm decision" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Escalation approved" })).toBeVisible();
  });
});
