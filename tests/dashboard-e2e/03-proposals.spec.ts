/**
 * /proposals (ProposalsPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §4.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady, captureConsoleErrors } from "./helpers";

test.describe("Proposals list (§4)", () => {
	test("PR-1 list renders with proposal table + heading count", async ({ page }) => {
		await page.goto("/proposals");
		await waitForDashboardReady(page);
		// Page heading "Proposals (N)" appears once the count is loaded.
		await expect(page.getByRole("heading", { name: /^Proposals \(\d+\)$/i, level: 1 })).toBeVisible({
			timeout: 15_000,
		});
		// And the table structure should render.
		await expect(page.getByRole("table").first()).toBeVisible({ timeout: 15_000 });
	});

	test("PR-4 click a proposal opens ProposalDetailsModal", async ({ page }) => {
		await page.goto("/proposals");
		await waitForDashboardReady(page);
		const firstRow = page.getByRole("button", { name: /^P\d+/ }).first();
		if (!(await firstRow.isVisible().catch(() => false))) {
			// Some implementations use links instead of buttons.
			const firstLink = page.getByRole("link", { name: /^P\d+/ }).first();
			test.skip(
				!(await firstLink.isVisible().catch(() => false)),
				"no proposal rows visible",
			);
			await firstLink.click();
		} else {
			await firstRow.click();
		}
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible({ timeout: 5_000 });
		await expect(modal).toContainText(/P\d+/);
	});

	test("PR-9 console hygiene on proposals page", async ({ page }) => {
		const getErrors = captureConsoleErrors(page);
		await page.goto("/proposals");
		await waitForDashboardReady(page);
		await page.waitForTimeout(2_000);
		const errors = getErrors().filter(
			(e) => !/favicon/.test(e) && !/Failed to load resource/.test(e),
		);
		expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
	});
});
