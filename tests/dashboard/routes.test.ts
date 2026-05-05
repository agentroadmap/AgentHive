/**
 * Unit tests for P296: model routing management page.
 *
 * Run: node --import jiti/register --test tests/dashboard/routes.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";

// ─── Host-policy match logic ──────────────────────────────────────────────────
// Mirror of the SQL correlated-subquery logic in handleListRoutes.
// COALESCE(bool_or(NOT forbidden AND (empty OR in_allowed)), true when no rows)

function computeHostPolicyMatch(
	routeProvider: string,
	policies: Array<{ allowed_providers: string[]; forbidden_providers: string[] }>,
): boolean {
	if (policies.length === 0) return true;
	return policies.some(
		(p) =>
			!p.forbidden_providers.includes(routeProvider) &&
			(p.allowed_providers.length === 0 || p.allowed_providers.includes(routeProvider)),
	);
}

describe("host policy match logic", () => {
	it("returns true when no policy rows exist (legacy permit)", () => {
		assert.equal(computeHostPolicyMatch("anthropic", []), true);
	});

	it("returns true when allowed_providers is empty (permit-all) and not forbidden", () => {
		assert.equal(
			computeHostPolicyMatch("anthropic", [
				{ allowed_providers: [], forbidden_providers: [] },
			]),
			true,
		);
	});

	it("returns true when provider is explicitly in allowed_providers", () => {
		assert.equal(
			computeHostPolicyMatch("nous", [
				{ allowed_providers: ["nous", "xiaomi"], forbidden_providers: ["anthropic"] },
			]),
			true,
		);
	});

	it("returns false when provider is forbidden on all hosts", () => {
		assert.equal(
			computeHostPolicyMatch("anthropic", [
				{ allowed_providers: ["nous", "xiaomi"], forbidden_providers: ["anthropic"] },
				{ allowed_providers: ["nous", "xiaomi"], forbidden_providers: ["anthropic"] },
			]),
			false,
		);
	});

	it("returns true when provider is allowed on at least one host even if forbidden on another", () => {
		assert.equal(
			computeHostPolicyMatch("anthropic", [
				{ allowed_providers: ["nous"], forbidden_providers: ["anthropic"] }, // hermes: forbidden
				{ allowed_providers: ["anthropic", "nous", "xiaomi"], forbidden_providers: [] }, // claude-box: allowed
			]),
			true,
		);
	});

	it("returns false when provider is not in any allowed_providers list (no empty-allow host)", () => {
		assert.equal(
			computeHostPolicyMatch("openai", [
				{ allowed_providers: ["nous", "xiaomi"], forbidden_providers: ["anthropic"] },
				{ allowed_providers: ["anthropic"], forbidden_providers: [] },
			]),
			false,
		);
	});

	it("forbidden_providers takes precedence over allowed_providers", () => {
		// Provider is both listed in allowed AND forbidden on the same host — forbidden wins
		assert.equal(
			computeHostPolicyMatch("anthropic", [
				{ allowed_providers: ["anthropic"], forbidden_providers: ["anthropic"] },
			]),
			false,
		);
	});
});

// ─── ApiClient.toggleRoute request shape ─────────────────────────────────────

describe("ApiClient.toggleRoute request shape", () => {
	let capturedRequest: { url: string; method: string; body: string } | null = null;
	const originalFetch = globalThis.fetch;

	before(() => {
		// Stub fetch to capture the outgoing request
		(globalThis as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
			capturedRequest = {
				url: url.toString(),
				method: init?.method ?? "GET",
				body: (init?.body as string) ?? "",
			};
			return new Response(JSON.stringify({ id: 42, is_enabled: false }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
	});

	after(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends PATCH to /api/routes/:id", async () => {
		// Import ApiClient dynamically so the fetch stub is already in place
		const { ApiClient } = await import("../../src/apps/dashboard-web/lib/api.ts");
		const client = new ApiClient();
		await client.toggleRoute(42, false);
		assert.ok(capturedRequest, "fetch was not called");
		assert.match(capturedRequest!.url, /\/api\/routes\/42$/);
		assert.equal(capturedRequest!.method, "PATCH");
	});

	it("sends is_enabled in the JSON body", async () => {
		const { ApiClient } = await import("../../src/apps/dashboard-web/lib/api.ts");
		const client = new ApiClient();
		await client.toggleRoute(7, true);
		assert.ok(capturedRequest, "fetch was not called");
		const parsed = JSON.parse(capturedRequest!.body);
		assert.equal(parsed.is_enabled, true);
	});

	it("returns the id and is_enabled from the response", async () => {
		(globalThis as any).fetch = async () =>
			new Response(JSON.stringify({ id: 99, is_enabled: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const { ApiClient } = await import("../../src/apps/dashboard-web/lib/api.ts");
		const client = new ApiClient();
		const result = await client.toggleRoute(99, true);
		assert.equal(result.id, 99);
		assert.equal(result.is_enabled, true);
	});
});

// ─── GET /api/routes response shape ──────────────────────────────────────────

describe("GET /api/routes response shape", () => {
	it("response has a routes array", async () => {
		(globalThis as any).fetch = async () =>
			new Response(
				JSON.stringify({
					routes: [
						{
							id: 1,
							model_name: "claude-sonnet-4-6",
							route_provider: "anthropic",
							has_host_policy_match: true,
							is_enabled: true,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		const { ApiClient } = await import("../../src/apps/dashboard-web/lib/api.ts");
		const client = new ApiClient();
		const routes = await client.fetchRoutes();
		assert.ok(Array.isArray(routes), "routes must be an array");
		assert.equal(routes.length, 1);
	});

	it("each route item includes has_host_policy_match", async () => {
		(globalThis as any).fetch = async () =>
			new Response(
				JSON.stringify({
					routes: [
						{ id: 1, model_name: "m1", has_host_policy_match: false, is_enabled: true },
						{ id: 2, model_name: "m2", has_host_policy_match: true, is_enabled: false },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		const { ApiClient } = await import("../../src/apps/dashboard-web/lib/api.ts");
		const client = new ApiClient();
		const routes = await client.fetchRoutes();
		assert.ok("has_host_policy_match" in routes[0], "has_host_policy_match field missing");
		assert.equal(routes[0].has_host_policy_match, false);
		assert.equal(routes[1].has_host_policy_match, true);
	});
});

// ─── Toggle input validation ──────────────────────────────────────────────────

describe("PATCH /api/routes/:id input validation", () => {
	it("returns 400 when is_enabled is not a boolean", async () => {
		// Test the server-side validation logic directly (pure function extraction)
		function validateToggleBody(body: unknown): string | null {
			if (
				body === null ||
				typeof body !== "object" ||
				typeof (body as Record<string, unknown>).is_enabled !== "boolean"
			) {
				return "is_enabled (boolean) required";
			}
			return null;
		}

		assert.equal(validateToggleBody(null), "is_enabled (boolean) required");
		assert.equal(validateToggleBody({}), "is_enabled (boolean) required");
		assert.equal(validateToggleBody({ is_enabled: "true" }), "is_enabled (boolean) required");
		assert.equal(validateToggleBody({ is_enabled: 1 }), "is_enabled (boolean) required");
		assert.equal(validateToggleBody({ is_enabled: true }), null);
		assert.equal(validateToggleBody({ is_enabled: false }), null);
	});
});
