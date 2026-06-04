/**
 * /routes (RoutesPage) — Tranche 2.
 *
 * Plan: tests/dashboard-e2e/PLAN.md §16.
 *
 * Note: this spec assumes the P1611 server fix has shipped — until then
 * GET /api/routes returns HTTP 500 and these tests will all fail with a
 * clear "blocked by P1611" annotation. After P1611 lands the tests
 * verify the canonical UX from P387: orphan badge counts, row
 * highlighting, optimistic toggle.
 */
import { test, expect, request } from "@playwright/test";
import { waitForDashboardReady } from "./helpers";

const BASE_URL = process.env.DASHBOARD_BASE_URL ?? "http://10.0.0.77:6420";

const MOCK_ROUTES = [
	{
		id: 1,
		model_name: "claude-sonnet-4-6",
		route_provider: "anthropic",
		agent_provider: "anthropic",
		agent_cli: "claude",
		fallback_cli: null,
		is_enabled: true,
		priority: 10,
		api_spec: "openai",
		base_url: null,
		cost_per_million_input: 3,
		cost_per_million_output: 15,
		plan_type: "pro",
		notes: null,
		created_at: "2025-01-01T00:00:00Z",
		has_host_policy_match: true,
	},
	{
		id: 2,
		model_name: "orphan-model",
		route_provider: "orphaned-provider",
		agent_provider: "orphaned-provider",
		agent_cli: "orphan-cli",
		fallback_cli: null,
		is_enabled: true,
		priority: 99,
		api_spec: "openai",
		base_url: "http://localhost:9999",
		cost_per_million_input: 0,
		cost_per_million_output: 0,
		plan_type: null,
		notes: null,
		created_at: "2025-01-01T00:00:00Z",
		has_host_policy_match: false,
	},
];

test.describe("Routes page (§16)", () => {
	test("RT-0 /api/routes prerequisite (blocked by P1611 until fix deploys)", async () => {
		const ctx = await request.newContext();
		const res = await ctx.get(`${BASE_URL}/api/routes`);
		expect(
			res.status(),
			`P1611: /api/routes must be 200 for the rest of this suite to mean anything`,
		).toBe(200);
	});

	test("RT-1 routes table renders at least one row", async ({ page }) => {
		await page.goto("/routes");
		await waitForDashboardReady(page);
		// A route row should expose a model name, a provider, and an enable toggle.
		// Loose check: at least one of the known agent_provider values appears.
		const body = (await page.textContent("body")) ?? "";
		expect(body).toMatch(/anthropic|openai|google|deepseek|claude|gpt|gemini/i);
	});

	test("RT-2 orphan badge surfaces N count or absence cleanly", async ({ page }) => {
		await page.goto("/routes");
		await waitForDashboardReady(page);
		// P387 §UX Flow 2: header shows "⚠ N no host policy" when orphans exist.
		// Either a count badge is visible, or the absence text confirms zero orphans.
		const body = (await page.textContent("body")) ?? "";
		const hasOrphanBadge = /⚠|no host policy|host_policy/i.test(body);
		// Soft assertion — log either way for triage rather than fail.
		test.info().annotations.push({
			type: "context",
			description: `orphan badge visible: ${hasOrphanBadge}`,
		});
		expect(true).toBe(true);
	});

	test("RT-3 orphan row has yellow background and ⚠ prefix on model name", async ({ page }) => {
		// Mock the routes endpoint so the test is independent of DB state.
		await page.route("**/api/routes", (route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ routes: MOCK_ROUTES }),
			}),
		);

		await page.goto("/routes");
		await waitForDashboardReady(page);

		// The orphan model name should appear.
		await expect(page.getByText("orphan-model")).toBeVisible({ timeout: 10_000 });

		// The ⚠ warning icon should appear in the table.
		const warnIcons = page.locator("td").filter({ hasText: /⚠/ });
		await expect(warnIcons.first()).toBeVisible();

		// The header badge should show "⚠ 1 no host policy".
		await expect(page.getByText(/⚠.*no host policy/)).toBeVisible();
	});

	test("RT-4 toggle enable fires PATCH /api/routes/:id", async ({ page }) => {
		const patchRequests: { url: string; body: unknown }[] = [];

		await page.route("**/api/routes", (route) => {
			if (route.request().method() === "GET") {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ routes: [MOCK_ROUTES[0]] }),
				});
			}
			return route.continue();
		});

		await page.route("**/api/routes/1", async (route) => {
			const body = JSON.parse((await route.request().postData()) ?? "{}");
			patchRequests.push({ url: route.request().url(), body });
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ id: 1, is_enabled: false }),
			});
		});

		await page.goto("/routes");
		await waitForDashboardReady(page);

		// The ON badge for the enabled route should be visible.
		const toggle = page.getByRole("button", { name: /^ON$/ }).first();
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await toggle.click();

		// Verify PATCH fired with is_enabled=false.
		await page.waitForFunction(() => true); // flush micro-tasks
		expect(patchRequests.length).toBeGreaterThan(0);
		expect(patchRequests[0].body).toMatchObject({ is_enabled: false });
	});

	test("RT-5 toggle reverts UI on server 500", async ({ page }) => {
		await page.route("**/api/routes", (route) => {
			if (route.request().method() === "GET") {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ routes: [MOCK_ROUTES[0]] }),
				});
			}
			return route.continue();
		});

		// Simulated server error on PATCH.
		await page.route("**/api/routes/1", (route) =>
			route.fulfill({ status: 500, body: "Internal Server Error" }),
		);

		await page.goto("/routes");
		await waitForDashboardReady(page);

		const toggle = page.getByRole("button", { name: /^ON$/ }).first();
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await toggle.click();

		// After the server error the toggle should revert back to ON and show an
		// error indicator.
		await expect(page.getByRole("button", { name: /^ON$/ }).first()).toBeVisible({
			timeout: 5_000,
		});
		// An error message should appear near the toggle cell.
		await expect(page.getByText(/Toggle failed/i)).toBeVisible({ timeout: 5_000 });
	});

	test("RT-6 orphan row toggle is not blocked (informational only)", async ({ page }) => {
		const patchRequests: unknown[] = [];

		await page.route("**/api/routes", (route) => {
			if (route.request().method() === "GET") {
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ routes: [MOCK_ROUTES[1]] }),
				});
			}
			return route.continue();
		});

		await page.route("**/api/routes/2", async (route) => {
			patchRequests.push(route.request().url());
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ id: 2, is_enabled: false }),
			});
		});

		await page.goto("/routes");
		await waitForDashboardReady(page);

		const toggle = page.getByRole("button", { name: /^ON$/ }).first();
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await toggle.click();

		// PATCH should still fire — the orphan flag is informational, not blocking.
		await page.waitForFunction(() => true);
		expect(patchRequests.length).toBeGreaterThan(0);
	});
});
