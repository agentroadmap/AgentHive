/**
 * /channels (ChannelsPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §8.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady, captureConsoleErrors } from "./helpers";

test.describe("Channels page (§8)", () => {
	test("CH-1 channel list renders with at least one known channel", async ({ page }) => {
		await page.goto("/channels");
		await waitForDashboardReady(page);
		const body = (await page.textContent("body")) ?? "";
		// At minimum, /api/channels exposes broadcast / direct / system / system:hiveCentral / team:*.
		// Assert one of these surfaces in the rendered text.
		expect(body).toMatch(/broadcast|direct|system|team:engineering/i);
	});

	test("CH-6 console clean during channel render", async ({ page }) => {
		const getErrors = captureConsoleErrors(page);
		await page.goto("/channels");
		await waitForDashboardReady(page);
		await page.waitForTimeout(2_000);
		const errors = getErrors().filter(
			(e) => !/favicon/.test(e) && !/Failed to load resource/.test(e),
		);
		expect(errors).toEqual([]);
	});
});
