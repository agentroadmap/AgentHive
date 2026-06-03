/**
 * /agents (AgentsPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §6.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady, captureConsoleErrors } from "./helpers";

test.describe("Agents page (§6)", () => {
	test("AG-1 page renders heading + count (currently shows 0 — see P1731)", async ({
		page,
	}) => {
		// Documents the current state: page renders "Agents (0)" despite /api/agents
		// returning 300+ rows. Once P1731 lands, this test should be updated to
		// assert non-zero or to verify the filter-aware heading.
		await page.goto("/agents");
		await waitForDashboardReady(page);
		await expect(page.getByRole("heading", { name: /^Agents \(\d+\)$/i, level: 1 })).toBeVisible({
			timeout: 15_000,
		});
	});

	test("AG-7 empty agent identities don't crash the page", async ({ page }) => {
		const getErrors = captureConsoleErrors(page);
		await page.goto("/agents");
		await waitForDashboardReady(page);
		await page.waitForTimeout(2_000);
		const errors = getErrors().filter(
			(e) =>
				!/favicon/.test(e) &&
				!/Failed to load resource/.test(e) &&
				!/DevTools/.test(e),
		);
		expect(errors).toEqual([]);
	});

	test("AG-3 sort controls visible (independent of data presence)", async ({ page }) => {
		await page.goto("/agents");
		await waitForDashboardReady(page);
		// Sort combobox is present even when agents=0 (see P1731 for the data issue).
		await expect(page.getByRole("combobox", { name: /sort by/i })).toBeVisible();
	});
});
