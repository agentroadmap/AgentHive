import { type Page, type Locator, expect } from "@playwright/test";

/**
 * Wait for the dashboard React app to finish initial paint + first WS snapshot.
 * Looks for the AppNav <nav role="navigation"> AND the project switcher
 * combobox (both reliable indicators that hydration completed).
 */
export async function waitForDashboardReady(page: Page) {
	// Desktop (>=md/768px): <nav role="navigation"> is rendered inline.
	// Mobile (<md): nav is collapsed into a closed drawer; only the hamburger button
	//   <button aria-label="Open navigation menu"> is visible.
	// Wait for whichever surfaces first.
	const viewport = page.viewportSize();
	const isMobile = viewport ? viewport.width < 768 : false;
	if (isMobile) {
		await expect(
			page.getByRole("button", { name: /open navigation menu/i }),
		).toBeVisible({ timeout: 30_000 });
	} else {
		await expect(page.getByRole("navigation").first()).toBeAttached({ timeout: 30_000 });
		await expect(
			page.getByRole("combobox", { name: /Active project/i }),
		).toBeVisible({ timeout: 30_000 });
	}
}

/**
 * Wait for the board to finish loading its first WS snapshot.
 * Detected via the "<N> proposals" status line in the header.
 */
export async function waitForBoardReady(page: Page) {
	await waitForDashboardReady(page);
	await expect(
		page.getByText(/\d+\s+proposals/i).first(),
	).toBeVisible({ timeout: 30_000 });
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
 * Locate a column on the board by its title (e.g. "DRAFT").
 * Note: ProposalColumn is <section aria-label="<title> proposal column"> in source,
 * but the deployed dashboard's accessibility tree flattens the section. Anchor on
 * the H3 heading instead, which is reliably the column title.
 */
export function boardColumn(page: Page, title: string): Locator {
	return page.getByRole("heading", { level: 3, name: new RegExp(`^${title}$`, "i") });
}

/**
 * Locate a proposal card on the board by its display id (e.g. "P1409").
 * Cards are <button> elements whose accessible name starts with the display id.
 */
export function proposalCard(page: Page, displayId: string): Locator {
	return page.getByRole("button", { name: new RegExp(`^${displayId}\\b`) }).first();
}

/**
 * Click a card and wait for the details modal to open.
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

/**
 * AppNav exposes only the first 4-5 nav links inline; the rest live behind
 * the "More ▾" overflow button. This helper opens the menu so any nav link
 * is reachable.
 */
export async function openNavOverflow(page: Page) {
	const more = page.getByRole("button", { name: /^More\b/i }).first();
	if (await more.isVisible().catch(() => false)) {
		await more.click();
	}
}
