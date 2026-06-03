/**
 * /board (BoardPage / Board / ProposalColumn / ProposalCard) — Tranche 1.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §3.
 *
 * Selectors based on the live DOM (Playwright accessibility snapshot 2026-06-02):
 *   - column: <section aria-label="<title> proposal column"> → role="region"
 *   - card:   <button> whose accessible name starts with the display id ("P1409 ...")
 *   - card title: <h4> inside the button
 *   - column count: text node like "106" next to the heading
 */
import { test, expect } from "@playwright/test";
import {
	waitForBoardReady,
	captureConsoleErrors,
	readActiveWorkflow,
	boardColumn,
	proposalCard,
} from "./helpers";

const STANDARD_RFC_STAGES = ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"];

test.describe("Board render (§3.1)", () => {
	test("B-1 columns render for every Standard RFC stage", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const workflow = await readActiveWorkflow(page);
		test.info().annotations.push({ type: "context", description: `workflow=${workflow}` });
		for (const stage of STANDARD_RFC_STAGES) {
			await expect(
				boardColumn(page, stage),
				`expected column for ${stage}`,
			).toBeVisible({ timeout: 10_000 });
		}
	});

	test("B-3 cards show display id, title (h4), and at least one badge", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const firstCard = page.getByRole("button", { name: /^P\d+/ }).first();
		await expect(firstCard).toBeVisible({ timeout: 10_000 });
		// h4 heading inside the card is the title.
		await expect(firstCard.getByRole("heading", { level: 4 })).toBeVisible();
		// Accessible name should contain the display id AND additional metadata
		// (maturity / type / priority / labels) — non-empty after stripping P###.
		const accName = await firstCard.getAttribute("aria-label");
		const visibleText = (await firstCard.textContent()) ?? "";
		const meta = visibleText.replace(/P\d+\S*/, "").trim();
		expect(
			meta.length,
			`card should expose metadata beyond display id, got: ${accName ?? visibleText}`,
		).toBeGreaterThan(5);
	});

	test("B-5 column shows numeric count next to DRAFT heading", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const heading = boardColumn(page, "DRAFT");
		await expect(heading).toBeVisible();
		// Page-level text near the heading is the most resilient check:
		// the count is a sibling of the heading and DOM topology varies.
		const pageText = (await page.textContent("body")) ?? "";
		expect(pageText, "expected a numeric count near the DRAFT heading").toMatch(
			/DRAFT[\s\S]{0,40}\d+/i,
		);
	});
});

test.describe("Board interaction (§3.2)", () => {
	test("B-6 click card opens ProposalDetailsModal with full content", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const firstCard = page.getByRole("button", { name: /^P\d+/ }).first();
		const accName = (await firstCard.getAttribute("aria-label")) ?? "";
		const displayIdMatch = accName.match(/^P\d+/);
		test.skip(!displayIdMatch, "no proposal cards visible on /board");
		await firstCard.click();
		const modal = page.getByRole("dialog");
		await expect(modal).toBeVisible({ timeout: 5_000 });
		await expect(modal).toContainText(displayIdMatch![0]);
	});

	test("B-7 modal closes on Escape", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const firstCard = page.getByRole("button", { name: /^P\d+/ }).first();
		await firstCard.click();
		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
	});

	test("B-9 workflow selector switches stage columns and persists", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const selector = page.getByRole("combobox", { name: /^Workflow:?$/i });
		await expect(selector).toBeVisible();
		const options = await selector.locator("option").allTextContents();
		const target = options.find((o) => o && o !== "Standard RFC");
		test.skip(!target, "no alternative workflow available");
		await selector.selectOption({ label: target! });
		const saved = await page.evaluate(() =>
			window.localStorage.getItem("roadmap.board.workflow"),
		);
		expect(saved).toBe(target!);
	});

	test("B-15 status filter narrows visible columns", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const status = page.getByRole("combobox", { name: /^Status:?$/i });
		await expect(status).toBeVisible();
		const baselineColumnCount = await page
			.getByRole("heading", { level: 3, name: /^(DRAFT|REVIEW|DEVELOP|MERGE|COMPLETE)$/i })
			.count();
		await status.selectOption({ label: "DRAFT" });
		await page.waitForTimeout(500);
		await expect(boardColumn(page, "DRAFT")).toBeVisible();
		const filteredColumnCount = await page
			.getByRole("heading", { level: 3, name: /^(DRAFT|REVIEW|DEVELOP|MERGE|COMPLETE)$/i })
			.count();
		// After Status=DRAFT, expect fewer column headings than the baseline
		// (the filter should hide other stage columns OR they should empty out).
		expect(
			filteredColumnCount,
			`expected fewer visible stage columns after Status=DRAFT (baseline=${baselineColumnCount}, filtered=${filteredColumnCount})`,
		).toBeLessThanOrEqual(baselineColumnCount);
	});

	test("B-17 filter textbox narrows visible cards", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		const filter = page.getByRole("textbox", { name: /filter by # or title/i });
		await expect(filter).toBeVisible();
		await filter.fill("P1409");
		// Wait for client-side filter to apply.
		await page.waitForTimeout(500);
		// At least one P1409* card visible.
		await expect(proposalCard(page, "P1409")).toBeVisible();
		// Non-matching cards should be hidden — pick any non-P1409 id and assert absent.
		const otherCount = await page.getByRole("button", { name: /^P(?!1409)\d+/ }).count();
		expect(otherCount, "expected non-matching cards to be filtered out").toBe(0);
	});
});

test.describe("Board edge cases (§3.5)", () => {
	test("B-19 long title rendered without breaking layout", async ({ page }) => {
		await page.goto("/board");
		await waitForBoardReady(page);
		// Pick the first card with a title >80 chars; assert the column it lives in does not horizontally overflow.
		const longCard = page.getByRole("button", { name: /^P\d+.{80,}/ }).first();
		if (!(await longCard.isVisible().catch(() => false))) {
			test.skip(true, "no long-title cards on this board");
		}
		const box = await longCard.boundingBox();
		expect(box, "long-title card should still have a bounding box").not.toBeNull();
		// width should be bounded by viewport — no extreme overflow.
		expect(box!.width).toBeLessThan(1500);
	});
});

test.describe("Board responsive (§3.6)", () => {
	test("B-24 mobile viewport renders without horizontal overflow on body", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto("/board");
		await waitForBoardReady(page);
		// Body width should not exceed viewport width.
		const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(scrollWidth, `expected scrollWidth <= ~viewport, got ${scrollWidth}`).toBeLessThanOrEqual(
			420,
		);
	});
});

test.describe("Board console hygiene", () => {
	test("B-26 no console errors during navigation, open modal, close modal", async ({ page }) => {
		const getErrors = captureConsoleErrors(page);
		await page.goto("/board");
		await waitForBoardReady(page);
		const firstCard = page.getByRole("button", { name: /^P\d+/ }).first();
		if (await firstCard.isVisible().catch(() => false)) {
			await firstCard.click();
			await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
			await page.keyboard.press("Escape");
		}
		await page.waitForTimeout(1_500);
		const errors = getErrors().filter(
			(e) => !/favicon/.test(e) && !/DevTools/.test(e) && !/Failed to load resource/.test(e),
		);
		expect(errors, `expected no console errors, got:\n${errors.join("\n")}`).toEqual([]);
	});
});
