import { type Page, expect } from "@playwright/test";

/**
 * Wait for the dashboard React app to finish initial paint + first WS snapshot.
 * Heuristic: AppNav rendered AND no spinner with role=status visible.
 */
export async function waitForDashboardReady(page: Page) {
	await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 15_000 });
	// Allow the React tree to settle and the first WS snapshot to land.
	await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * Collect console errors on a page for later assertion.
 * Returns a getter that yields the accumulated errors.
 */
export function captureConsoleErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	page.on("pageerror", (err) => {
		errors.push(`pageerror: ${err.message}`);
	});
	return () => errors.slice();
}

/**
 * Set project scope in localStorage before navigation so requests carry X-Project-Id.
 */
export async function setProjectScope(page: Page, projectId: string) {
	await page.addInitScript((id) => {
		try {
			window.localStorage.setItem("roadmap.project_scope.v1", id);
		} catch {}
	}, projectId);
}

/**
 * Force a theme regardless of system preference.
 */
export async function setTheme(page: Page, theme: "light" | "dark") {
	await page.addInitScript((t) => {
		try {
			window.localStorage.setItem("roadmap-theme", t);
		} catch {}
	}, theme);
}

/**
 * Find a proposal card on the board by its displayId (e.g. "P1409").
 */
export function proposalCard(page: Page, displayId: string) {
	return page.locator(`[data-testid="proposal-card"], .proposal-card`).filter({
		hasText: displayId,
	}).first();
}

/**
 * Open the ProposalDetailsModal for the given displayId by clicking its card.
 */
export async function openProposalModal(page: Page, displayId: string) {
	await proposalCard(page, displayId).click();
	await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
}

/**
 * Close the open modal via Escape.
 */
export async function closeModal(page: Page) {
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
}

/**
 * Read the active workflow name from localStorage (or default).
 */
export async function readActiveWorkflow(page: Page): Promise<string> {
	return await page.evaluate(() => {
		return window.localStorage.getItem("roadmap.board.workflow") ?? "Standard RFC";
	});
}
