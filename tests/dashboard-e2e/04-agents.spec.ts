/**
 * /agents (AgentsPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §6.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady, captureConsoleErrors } from "./helpers";

test.describe("Agents page (§6)", () => {
	test("AG-1 page renders heading + count (P1731: now shows actual agent count)", async ({
		page,
	}) => {
		// P1731 fix: verified that page renders agents from HTTP /api/agents endpoint.
		// With live DB, expects 300+ agents (actually 607 in dev). Test asserts
		// heading shows non-zero count (not "Agents (0)").
		await page.goto("/agents");
		await waitForDashboardReady(page);
		// Heading regex must match "Agents (N)" where N > 0
		const heading = await page.getByRole("heading", { name: /^Agents \(\d+\)$/i, level: 1 });
		await expect(heading).toBeVisible({ timeout: 15_000 });
		// Extract count from heading text and verify > 0
		const headingText = await heading.textContent();
		const match = headingText?.match(/\((\d+)\)/);
		const agentCount = match ? parseInt(match[1], 10) : 0;
		expect(agentCount).toBeGreaterThan(0);
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
