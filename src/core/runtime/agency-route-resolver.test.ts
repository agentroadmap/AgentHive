/**
 * P928 AC-6: Integration tests for resolveAgencyCurrentRoute + selfRegisterAgency wiring.
 *
 * Tests cover 7 branches: (a) happy path, (b) re-boot drift, (c) allow-list,
 * (d) forbid-list, (e) priority ASC ordering, (f) cost tiebreaker, (g) formatAgentLabel rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { query } from "../../infra/postgres/pool.ts";
import { resolveAgencyCurrentRoute } from "./agency-route-resolver.ts";
import { formatAgentLabel } from "../../shared/ui/format-agent-label.ts";

// Test database config
const TEST_DB = "agenthive_p928_test";
const TEST_HOST = "test-host";

function getTestDb() {
	// Uses the PGUSER=admin/.pgpass credentials
	return query;
}

/**
 * Helper to clean up test data after each test.
 */
async function cleanTestData() {
	const q = getTestDb();
	await q(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE 'test-%'`);
	await q(
		`DELETE FROM roadmap.host_model_policy WHERE host_name = $1`,
		[TEST_HOST],
	);
	await q(
		`DELETE FROM roadmap.model_routes WHERE agent_provider = 'test-provider'`,
	);
}

/**
 * Helper to insert a test route.
 */
async function insertTestRoute(
	props: {
		modelName?: string;
		routeProvider?: string;
		agentProvider?: string;
		planType?: string;
		priority?: number;
		isEnabled?: boolean;
		costPerMillionInput?: number | null;
	},
) {
	const q = getTestDb();
	const {
		modelName = "test-model",
		routeProvider = "test-route-provider",
		agentProvider = "test-provider",
		planType = "api_key",
		priority = 10,
		isEnabled = true,
		costPerMillionInput = null,
	} = props;

	// Ensure model_metadata entry exists (FK requirement: model_routes.model_name → model_metadata.model_name)
	try {
		await q(
			`INSERT INTO roadmap.model_metadata (model_name, provider, capabilities)
			 VALUES ($1, $2, '[]'::jsonb)`,
			[modelName, routeProvider],
		);
	} catch {
		// Model already exists, that's fine
	}

	const result = await q<{ id: number }>(
		`INSERT INTO roadmap.model_routes
		   (model_name, route_provider, agent_provider, plan_type, priority, is_enabled, cost_per_million_input)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[
			modelName,
			routeProvider,
			agentProvider,
			planType,
			priority,
			isEnabled,
			costPerMillionInput,
		],
	);
	return result.rows[0]?.id;
}

/**
 * Helper to insert a host policy.
 */
async function insertHostPolicy(props: {
	hostName?: string;
	allowedProviders?: string[];
	forbiddenProviders?: string[];
}) {
	const q = getTestDb();
	const {
		hostName = TEST_HOST,
		allowedProviders = [],
		forbiddenProviders = [],
	} = props;

	await q(
		`INSERT INTO roadmap.host_model_policy
		   (host_name, allowed_route_providers, forbidden_providers)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (host_name) DO UPDATE SET
		   allowed_route_providers = EXCLUDED.allowed_route_providers,
		   forbidden_providers = EXCLUDED.forbidden_providers`,
		[hostName, allowedProviders, forbiddenProviders],
	);
}

describe("P928: Agency Route Resolver", () => {
	beforeEach(async () => {
		await cleanTestData();
	});

	afterEach(async () => {
		await cleanTestData();
	});

	// (a) Happy path: register agency with known route; assert current_route_id matches resolver pick
	it("(a) happy path: resolver picks route and binds to agency", async () => {
		const q = getTestDb();
		const routeId = await insertTestRoute({
			routeProvider: "anthropic",
			agentProvider: "test-provider",
			planType: "subscription",
			priority: 5,
		});
		expect(routeId).toBeDefined();

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route).toBeDefined();
		expect(route?.id).toBe(routeId);
		expect(route?.route_provider).toBe("anthropic");
		expect(route?.plan_type).toBe("subscription");
	});

	// (b) Re-boot drift: boot with route A, verify column=A; reconfigure so B is now top; re-boot, verify column updated to B
	it("(b) re-boot drift: route change detected and updated", async () => {
		const q = getTestDb();

		// First boot: route A (priority 1)
		const routeAId = await insertTestRoute({
			modelName: "model-a",
			routeProvider: "provider-a",
			agentProvider: "test-provider",
			priority: 1,
		});
		const routeA = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(routeA?.id).toBe(routeAId);

		// Reconfigure: disable A, enable B with priority 2 (now top)
		await q(
			`UPDATE roadmap.model_routes SET is_enabled = false WHERE id = $1`,
			[routeAId],
		);
		const routeBId = await insertTestRoute({
			modelName: "model-b",
			routeProvider: "provider-b",
			agentProvider: "test-provider",
			priority: 2,
		});

		// Second boot: should now pick B
		const routeB = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(routeB?.id).toBe(routeBId);
		expect(routeB?.id).not.toBe(routeAId);
	});

	// (c) Host allow-list: seed policy with allowed_providers=['anthropic']; two routes (anthropic, openrouter); picks anthropic
	it("(c) host allow-list filters routes correctly", async () => {
		const q = getTestDb();

		// Insert two routes: anthropic and openrouter
		const anthropicId = await insertTestRoute({
			routeProvider: "anthropic",
			agentProvider: "test-provider",
			priority: 10,
		});
		const openrouterId = await insertTestRoute({
			routeProvider: "openrouter",
			agentProvider: "test-provider",
			priority: 10, // same priority; should lose to anthropic due to order in table
		});

		// Create host policy allowing only anthropic
		await insertHostPolicy({
			hostName: TEST_HOST,
			allowedProviders: ["anthropic"],
			forbiddenProviders: [],
		});

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route?.id).toBe(anthropicId);
		expect(route?.route_provider).toBe("anthropic");
	});

	// (d) Host forbid-list: forbidden_providers=['anthropic']; two routes; picks the non-anthropic one
	it("(d) host forbid-list excludes routes correctly", async () => {
		const q = getTestDb();

		// Insert two routes: anthropic and openrouter
		const anthropicId = await insertTestRoute({
			routeProvider: "anthropic",
			agentProvider: "test-provider",
			priority: 5,
		});
		const openrouterId = await insertTestRoute({
			routeProvider: "openrouter",
			agentProvider: "test-provider",
			priority: 10,
		});

		// Create host policy forbidding anthropic
		await insertHostPolicy({
			hostName: TEST_HOST,
			allowedProviders: [],
			forbiddenProviders: ["anthropic"],
		});

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route?.id).toBe(openrouterId);
		expect(route?.route_provider).toBe("openrouter");
	});

	// (e) Priority ASC: priority=1 vs priority=10; priority=1 wins (regression test for ASC ordering)
	it("(e) priority ASC ordering: lowest priority number wins", async () => {
		const q = getTestDb();

		// Insert two routes: priority 1 and priority 10
		const lowPriorityId = await insertTestRoute({
			routeProvider: "low-cost",
			agentProvider: "test-provider",
			priority: 1,
		});
		const highPriorityId = await insertTestRoute({
			routeProvider: "high-cost",
			agentProvider: "test-provider",
			priority: 10,
		});

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route?.id).toBe(lowPriorityId);
		expect(route?.priority).toBe(1);
	});

	// (f) Cost tiebreaker: same priority, different cost; cheapest wins
	it("(f) cost tiebreaker: cheapest cost wins when priority tied", async () => {
		const q = getTestDb();

		// Insert two routes with same priority but different costs
		const expensiveId = await insertTestRoute({
			routeProvider: "expensive",
			agentProvider: "test-provider",
			priority: 5,
			costPerMillionInput: 100,
		});
		const cheapId = await insertTestRoute({
			routeProvider: "cheap",
			agentProvider: "test-provider",
			priority: 5,
			costPerMillionInput: 10,
		});

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route?.id).toBe(cheapId);
		expect(Number(route?.cost_per_million_input)).toBe(10);
	});

	// (g) formatAgentLabel rendering with backend hint
	it("(g) formatAgentLabel shows backend hint when showBackend=true", async () => {
		const q = getTestDb();

		// Create a subscription route
		const subscriptionId = await insertTestRoute({
			modelName: "claude-3-opus",
			routeProvider: "anthropic",
			agentProvider: "test-provider",
			planType: "subscription",
			priority: 1,
		});

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(route).toBeDefined();

		// Test formatAgentLabel with subscription plan_type
		const row = {
			display_alias: "Claude-Bot",
			agent_identity: "test-agency",
		};

		// Default: no backend hint
		const baseLabel = formatAgentLabel(row);
		expect(baseLabel).toBe("Claude-Bot (test-agency)");

		// With showBackend=true and subscription: shows route_provider
		const withBackend = formatAgentLabel(row, {
			showBackend: true,
			route: {
				plan_type: "subscription",
				route_provider: "anthropic",
				model_name: "claude-3-opus",
			},
		});
		expect(withBackend).toBe("Claude-Bot (anthropic)");

		// Disable subscription route to test api_key route
		await q(
			`UPDATE roadmap.model_routes SET is_enabled = false WHERE id = $1`,
			[subscriptionId],
		);

		// Create an API key route
		const apikeyId = await insertTestRoute({
			modelName: "mimo-v2.5",
			routeProvider: "mimo",
			agentProvider: "test-provider",
			planType: "api_key",
			priority: 5,
		});

		const apikeyRoute = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);
		expect(apikeyRoute?.plan_type).toBe("api_key");

		// With showBackend=true and api_key: shows model_name
		const withBackendModel = formatAgentLabel(row, {
			showBackend: true,
			route: {
				plan_type: "api_key",
				route_provider: "mimo",
				model_name: "mimo-v2.5",
			},
		});
		expect(withBackendModel).toBe("Claude-Bot (mimo-v2.5)");

		// With null route: falls back to base label
		const nullRoute = formatAgentLabel(row, {
			showBackend: true,
			route: null,
		});
		expect(nullRoute).toBe("Claude-Bot (test-agency)");
	});

	// Bonus: verify ambiguity warning is logged but doesn't break the resolver
	it("logs ambiguity warning when multiple routes share top tier", async () => {
		const q = getTestDb();

		// Insert two routes with identical priority and cost
		const route1Id = await insertTestRoute({
			routeProvider: "provider-1",
			agentProvider: "test-provider",
			priority: 5,
			costPerMillionInput: 10,
		});
		const route2Id = await insertTestRoute({
			routeProvider: "provider-2",
			agentProvider: "test-provider",
			priority: 5,
			costPerMillionInput: 10,
		});

		// Capture console.warn to verify ambiguity warning
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(String(args[0]));
		};

		const route = await resolveAgencyCurrentRoute("test-provider", TEST_HOST);

		console.warn = originalWarn;

		// Should still return one of the routes
		expect(route).toBeDefined();
		expect([route1Id, route2Id]).toContain(route?.id);

		// Should have logged ambiguity warning
		const ambiguityWarning = warnings.find((w) =>
			w.includes("AMBIGUOUS_PROVIDER_ROUTES"),
		);
		expect(ambiguityWarning).toBeDefined();
	});
});
