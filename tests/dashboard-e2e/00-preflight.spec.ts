/**
 * Pre-flight environment checks. If any of these fail, the rest of the suite
 * will fail meaninglessly, so this spec runs first and bails the rest of the
 * run via test.fail() / skip patterns.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §0.
 */
import { test, expect, request } from "@playwright/test";

const BASE_URL = process.env.DASHBOARD_BASE_URL ?? "http://10.0.0.77:6420";

test.describe("Pre-flight (§0)", () => {
	test("PF-1 server reachable on /board", async () => {
		const ctx = await request.newContext();
		const res = await ctx.get(`${BASE_URL}/board`);
		expect(res.status()).toBe(200);
		const html = await res.text();
		expect(html.length).toBeGreaterThan(500);
		expect(html).toContain("AgentHive");
	});

	test("PF-2 static assets served", async () => {
		const ctx = await request.newContext();
		for (const path of ["/main.css", "/styles/style.css", "/favicon.png"]) {
			const res = await ctx.get(`${BASE_URL}${path}`);
			expect(res.status(), `expected 200 for ${path}`).toBe(200);
		}
	});

	test("PF-3 /api/proposals responds with array", async () => {
		const ctx = await request.newContext();
		const res = await ctx.get(`${BASE_URL}/api/proposals?limit=1`);
		expect(res.status()).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
	});

	test("PF-5 /api/version exposed", async () => {
		const ctx = await request.newContext();
		const res = await ctx.get(`${BASE_URL}/api/version`);
		expect(res.status()).toBe(200);
		const data = await res.json();
		expect(data).toHaveProperty("version");
		expect(typeof data.version).toBe("string");
	});

	test("PF-6 no console errors on /board initial load", async ({ page }) => {
		const errors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(msg.text());
		});
		page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
		await page.goto("/board");
		await page.waitForLoadState("networkidle").catch(() => {});
		// Allow some 3rd-party hydration noise but assert no React or app-code errors.
		const appErrors = errors.filter(
			(e) =>
				!/Failed to load resource.*favicon/.test(e) &&
				!/DevTools/.test(e),
		);
		expect(appErrors, `unexpected console errors:\n${appErrors.join("\n")}`).toEqual([]);
	});
});
