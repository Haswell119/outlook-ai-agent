import { expect, test } from "@playwright/test";

test.describe("system status", () => {
  test("shows health, models, queue, caches and mailbox sync", async ({ page }) => {
    await page.goto("/system");
    await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();

    await expect(page.getByText("Health checks", { exact: true })).toBeVisible();
    await expect(page.getByText("qwen3-30b-a3b").first()).toBeVisible();

    await expect(page.getByText("LLM queue").first()).toBeVisible();
    await expect(page.getByText("Concurrency")).toBeVisible();
    await expect(page.getByText("Closed")).toBeVisible();

    await expect(page.getByText("Cache hit rates")).toBeVisible();
    await expect(page.getByText("Analysis cache")).toBeVisible();

    await expect(page.getByText("Uptime:")).toBeVisible();
    await expect(page.getByText("Auto-refreshes every 15 s")).toBeVisible();

    // The /metrics note, not a proxy to it.
    await expect(page.getByText(/Prometheus metrics/)).toBeVisible();
    await expect(page.getByText("/metrics", { exact: true })).toBeVisible();
  });

  test("Sync now requests a mailbox synchronisation", async ({ page }) => {
    await page.goto("/system");
    await expect(page.getByText("Mailbox synchronisation", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Synchronisation requested" }),
    ).toBeVisible();
    await expect(page.getByText("Indexed emails")).toBeVisible();
  });

  test("the navigation reflects the admin role", async ({ page }) => {
    await page.goto("/system");
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link", { name: "System" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Policy Center" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  });
});
