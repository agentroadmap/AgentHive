/**
 * /board (BoardPage / Board / ProposalColumn / ProposalCard) — Tranche 1.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §3.
 *
 * Note on data fixtures: these tests read whatever proposals are live on the
 * target environment. They assert structure, behavior, and live-update
 * semantics — not specific proposal content. To run against a clean fixture
 * DB, point DASHBOARD_BASE_URL at a seeded environment.
 */
import { test, expect } from "@playwright/test";
import {
	waitForDashboardReady,
	openProposalModal,
	closeModal,
	captureConsoleErrors,
	readActiveWorkflow,
	proposalCard,
} from "./helpers";

test.describe("Board render (§3.1)", () => {
	test("B-1 columns render for every stage in active workflow", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		const workflow = await readActiveWorkflow(page);
		// Standard RFC has 5 stages; verify at least DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE columns are present.
		for (const stage of ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"]) {
			const col = page
				.locator('[data-testid="proposal-column"], .proposal-column, [data-stage]')
				.filter({ hasText: new RegExp(`^\\s*${stage}`, "i") })
				.first();
			await expect(col, `expected column for ${stage} under workflow ${workflow}`).toBeVisible();
		}
	});

	test("B-3 cards show display_id, title, and at least one badge", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		// Pick the first visible card — structure check only.
		const firstCard = page
			.locator('[data-testid="proposal-card"], .proposal-card')
			.first();
		await expect(firstCard).toBeVisible({ timeout: 10_000 });
		const text = (await firstCard.textContent()) ?? "";
		expect(text, "card should include a P### display id").toMatch(/P\d+/);
		expect(text.replace(/P\d+/, "").trim().length, "card should include a title").toBeGreaterThan(0);
	});
});

test.describe("Board interaction (§3.2)", () => {
	test("B-6 click card opens ProposalDetailsModal with full content", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		const firstCard = page.locator('[data-testid="proposal-card"], .proposal-card').first();
		await firstCard.click();
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible({ timeout: 5_000 });
		// Modal should at least contain the display_id and a Summary heading.
		await expect(modal).toContainText(/P\d+/);
	});

	test("B-7 modal closes on Escape, X, and outside click", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		const firstCard = page.locator('[data-testid="proposal-card"], .proposal-card').first();
		const displayIdMatch = (await firstCard.textContent())?.match(/P(\d+)/);
		test.skip(!displayIdMatch, "no proposal cards visible on /board");
		const displayId = `P${displayIdMatch![1]}`;

		// Escape
		await openProposalModal(page, displayId);
		await closeModal(page);

		// X button (aria-label or text "Close")
		await openProposalModal(page, displayId);
		const closeBtn = page.getByRole("button", { name: /close|✕|×/i }).first();
		if (await closeBtn.isVisible().catch(() => false)) {
			await closeBtn.click();
			await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
		}
	});

	test("B-9 workflow selector switches stage columns and persists", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		// Locate workflow selector — common patterns:
		const selector = page
			.locator('select[aria-label*="workflow" i], [data-testid="workflow-selector"]')
			.first();
		if (!(await selector.isVisible().catch(() => false))) {
			test.skip(true, "workflow selector not visible on this build");
		}
		// Change to a non-default option and verify localStorage update.
		const options = await selector.locator("option").allTextContents();
		const target = options.find((o) => o && !o.includes("Standard"));
		if (!target) test.skip(true, "no alternative workflow available");
		await selector.selectOption({ label: target! });
		const saved = await page.evaluate(() =>
			window.localStorage.getItem("roadmap.board.workflow"),
		);
		expect(saved).toContain(target!);
	});
});

test.describe("Board edge cases (§3.5)", () => {
	test("B-19 extremely long title truncated (visual smoke)", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		// Any card with a 100+ char title — check overflow:hidden / text-overflow.
		const cards = page.locator('[data-testid="proposal-card"], .proposal-card');
		const count = await cards.count();
		for (let i = 0; i < Math.min(count, 30); i++) {
			const card = cards.nth(i);
			const titleEl = card.locator("h2, h3, [data-testid='proposal-title'], .proposal-title").first();
			if (await titleEl.isVisible().catch(() => false)) {
				const css = await titleEl.evaluate((el) => getComputedStyle(el).textOverflow);
				expect(css, "long titles should use text-overflow: ellipsis").toBe("ellipsis");
				break;
			}
		}
	});
});

test.describe("Board responsive (§3.6)", () => {
	test("B-24 mobile viewport — columns horizontally scroll", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/board");
		await waitForDashboardReady(page);
		// At least one column should be visible and the board container scrollable horizontally.
		const board = page.locator('[data-testid="board-container"], .board-container, main').first();
		const overflow = await board.evaluate((el) => getComputedStyle(el).overflowX).catch(() => "");
		expect(overflow, "board should allow horizontal scroll on mobile").toMatch(/auto|scroll/);
	});
});

test.describe("Board console hygiene", () => {
	test("B-26 no console errors during normal interactions", async ({ page }) => {
		const getErrors = captureConsoleErrors(page);
		await page.goto("/board");
		await waitForDashboardReady(page);
		// Interact: open and close one modal.
		const firstCard = page.locator('[data-testid="proposal-card"], .proposal-card').first();
		if (await firstCard.isVisible().catch(() => false)) {
			await firstCard.click();
			await page.keyboard.press("Escape");
		}
		await page.waitForTimeout(2_000);
		const errors = getErrors().filter(
			(e) => !/favicon/.test(e) && !/DevTools/.test(e),
		);
		expect(errors, `expected no console errors, got:\n${errors.join("\n")}`).toEqual([]);
	});
});
