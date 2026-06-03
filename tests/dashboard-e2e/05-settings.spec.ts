/**
 * /settings (SettingsPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §17.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady } from "./helpers";

test.describe("Settings page (§17)", () => {
	test("SET-1 settings form loads with at least one field", async ({ page }) => {
		await page.goto("/settings");
		await waitForDashboardReady(page);
		// The settings form should expose at least one textbox or select.
		const inputs = page.getByRole("textbox").or(page.getByRole("combobox"));
		await expect(inputs.first()).toBeVisible({ timeout: 15_000 });
	});

	test("SET-1b api/config endpoint is reachable from the page", async ({ page }) => {
		const responses: number[] = [];
		page.on("response", (res) => {
			if (res.url().includes("/api/config")) responses.push(res.status());
		});
		await page.goto("/settings");
		await waitForDashboardReady(page);
		await page.waitForTimeout(2_500);
		// At least one /api/config GET should have happened with a 200.
		expect(responses.some((s) => s === 200), `responses: ${responses.join(",")}`).toBe(true);
	});
});
