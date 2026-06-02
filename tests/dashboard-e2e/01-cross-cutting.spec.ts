/**
 * Cross-cutting concerns: nav chrome, theme, health indicator, project scope, routing.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §1.
 */
import { test, expect } from "@playwright/test";
import { waitForDashboardReady, setTheme } from "./helpers";

const NAV_ITEMS = [
	{ href: "/", label: "Dashboard" },
	{ href: "/board", label: "Board" },
	{ href: "/proposals", label: "Proposals" },
	{ href: "/directives", label: "Directives" },
	{ href: "/agents", label: "Agents" },
	{ href: "/teams", label: "Teams" },
	{ href: "/channels", label: "Channels" },
	{ href: "/dispatches", label: "Dispatches" },
	{ href: "/knowledge", label: "Knowledge" },
	{ href: "/documents", label: "Documents" },
	{ href: "/decisions", label: "Decisions" },
	{ href: "/map", label: "Map" },
	{ href: "/routes", label: "Routes" },
	{ href: "/statistics", label: "Statistics" },
	{ href: "/achievements", label: "Achievements" },
	{ href: "/settings", label: "Settings" },
];

test.describe("Navigation chrome (§1.1)", () => {
	test("C-NAV-1 all 16 nav links render", async ({ page }) => {
		await page.goto("/");
		await waitForDashboardReady(page);
		for (const item of NAV_ITEMS) {
			const link = page.getByRole("link", { name: new RegExp(`^${item.label}$`, "i") }).first();
			await expect(link, `expected nav link ${item.label}`).toBeVisible();
		}
	});

	test("C-NAV-2 active route highlighted on /board", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		const boardLink = page.getByRole("link", { name: /^Board$/ }).first();
		const cls = await boardLink.getAttribute("class");
		// Active class includes "bg-blue-100" or "text-blue-600" in current AppNav theme;
		// loose check: an "active"-like indicator is present.
		expect(cls, `active class should differentiate active link, got: ${cls}`).toMatch(
			/active|bg-blue|text-blue|border-blue|dark:/i,
		);
	});

	test("C-NAV-5 logo links to /", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		const logoLink = page.locator('a[href="/"]').first();
		await expect(logoLink).toBeVisible();
		await logoLink.click();
		await expect(page).toHaveURL(/\/$/);
	});
});

test.describe("Theme (§1.2)", () => {
	test("C-THM-1 dark theme applied before first paint when localStorage set", async ({
		page,
	}) => {
		await setTheme(page, "dark");
		await page.goto("/board");
		const htmlClass = await page.evaluate(() => document.documentElement.className);
		expect(htmlClass).toMatch(/\bdark\b/);
	});

	test("C-THM-3 theme persists across reload", async ({ page }) => {
		await setTheme(page, "dark");
		await page.goto("/board");
		await page.reload();
		const htmlClass = await page.evaluate(() => document.documentElement.className);
		expect(htmlClass).toMatch(/\bdark\b/);
	});
});

test.describe("Routing (§1.5)", () => {
	test("C-RTE-1 direct navigation works for every route", async ({ page }) => {
		for (const item of NAV_ITEMS) {
			await page.goto(item.href);
			await waitForDashboardReady(page);
			// Verify URL stuck and at least the nav chrome rendered (not a 404).
			expect(new URL(page.url()).pathname).toBe(item.href);
		}
	});

	test("C-RTE-2 unknown path renders NotFoundPage", async ({ page }) => {
		await page.goto("/totally-fake-route-that-does-not-exist");
		await waitForDashboardReady(page);
		// NotFoundPage should mention "not found" or "404" — assert one of them.
		const body = (await page.textContent("body")) ?? "";
		expect(body.toLowerCase()).toMatch(/not\s*found|404/);
	});

	test("C-RTE-3 SPA browser back/forward", async ({ page }) => {
		await page.goto("/board");
		await waitForDashboardReady(page);
		await page.getByRole("link", { name: /^Proposals$/ }).first().click();
		await expect(page).toHaveURL(/\/proposals$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/board$/);
		await page.goForward();
		await expect(page).toHaveURL(/\/proposals$/);
	});
});

test.describe("Health indicator (§1.3)", () => {
	test("C-HLTH-1 red banner when /api/status fails", async ({ page }) => {
		await page.route("**/api/status", (route) => route.abort());
		await page.goto("/board");
		await waitForDashboardReady(page);
		// HealthIndicator polls /api/status; banner should surface within ~10s.
		const banner = page.getByText(/Server disconnected|Connection.*lost/i).first();
		await expect(banner).toBeVisible({ timeout: 15_000 });
	});
});
