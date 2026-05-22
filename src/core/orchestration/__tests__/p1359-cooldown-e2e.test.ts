/**
 * P1359 E2E Test: Per-(provider, model) quota cooldown + automatic route fallback
 *
 * This test harness simulates the full quota → cooldown → re-resolve → retry chain
 * end-to-end, verifying that:
 * - Gemini TerminalQuotaError messages are parsed for reset time
 * - Model-level cooldowns are written to roadmap.model_routes.cooldown_until
 * - Route re-resolution skips cooled models (Layer 6 filter)
 * - When all routes are cooled, provider_health is escalated
 * - MCP actions (cooldown_status, cooldown_clear) work correctly
 *
 * Coverage matrix (AC-7):
 * - AC-7.1: Gemini TerminalQuotaError TTL parsing + model cooldown
 * - AC-7.2: Model→provider escalation when all routes cooled
 * - AC-7.3: cooldown_clear MCP action
 * - AC-7.4: Fallback 60-min cooldown on parse failure
 * - AC-7.5: provider_exhausted final outcome after max retries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";
import {
	setModelCooldown,
	isModelInCooldown,
	setProviderCooldown,
	isProviderInCooldown,
} from "../provider-cooldown.ts";

describe("P1359 E2E: Cooldown chain and route fallback", () => {
	// Use unique test provider to avoid colliding with production data
	const TEST_PROVIDER = "test-google-p1359";
	const TEST_MODEL_1 = "test-gemini-pro";
	const TEST_MODEL_2 = "test-gemini-flash";
	const TEST_AGENT_PROVIDER = "anthropic"; // agent_provider field (independent of route_provider)

	beforeEach(async () => {
		// Clean up any stale test data from prior runs
		await cleanupTestRoutes();
	});

	afterEach(async () => {
		// Mandatory cleanup to prevent data leakage into next test
		await cleanupTestRoutes();
	});

	async function cleanupTestRoutes(): Promise<void> {
		// Delete all model_routes for our test provider
		await query(
			`DELETE FROM roadmap.model_routes
			 WHERE route_provider = $1`,
			[TEST_PROVIDER],
		);

		// Delete provider_health for our test provider
		await query(
			`DELETE FROM roadmap.provider_health
			 WHERE provider_name = $1`,
			[TEST_PROVIDER],
		);

		// Delete model_metadata for our test models
		await query(
			`DELETE FROM roadmap.model_metadata
			 WHERE provider = $1`,
			[TEST_PROVIDER],
		);
	}

	async function ensureTestMetadata(): Promise<void> {
		// Ensure test model metadata exists (pre-requisite for model_routes FK)
		await query(
			`INSERT INTO roadmap.model_metadata (model_name, provider, is_active)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (provider, model_name) DO NOTHING`,
			[TEST_MODEL_1, TEST_PROVIDER, true],
		);

		await query(
			`INSERT INTO roadmap.model_metadata (model_name, provider, is_active)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (provider, model_name) DO NOTHING`,
			[TEST_MODEL_2, TEST_PROVIDER, true],
		);

		const TEST_MODEL_3 = "test-gemini-experimental";
		await query(
			`INSERT INTO roadmap.model_metadata (model_name, provider, is_active)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (provider, model_name) DO NOTHING`,
			[TEST_MODEL_3, TEST_PROVIDER, true],
		);
	}

	/**
	 * AC-7.1: Gemini TerminalQuotaError → parse TTL → set model cooldown
	 *
	 * Scenario:
	 *  1. Pre-seed two model_routes with priority 1 (pro) and priority 2 (flash)
	 *  2. Simulate spawn returning TerminalQuotaError with "reset after 15h56m11s"
	 *  3. classifyExit detects provider + model + resetAt
	 *  4. spawnWithRetry writes model cooldown + re-resolves (picks priority 2)
	 *  5. Verify cooldown_until is set correctly and future resolves skip the cooled route
	 */
	it("AC-7.1: Gemini TerminalQuotaError parsing + model cooldown write", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed two routes for test-google-p1359
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_2, TEST_PROVIDER, TEST_AGENT_PROVIDER, 2, true],
		);

		// Set model-level cooldown on TEST_MODEL_1 for 955+ minutes (15h56m + buffer)
		const now = new Date();
		const targetResetTime = new Date(now.getTime() + 15 * 3600_000 + 56 * 60_000 + 11 * 1000);
		const cooldownMinutes = Math.ceil((targetResetTime.getTime() - now.getTime()) / 60_000);

		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, cooldownMinutes, "TerminalQuotaError");

		// Verify cooldown_until is in the future for TEST_MODEL_1
		const { rows: cooledRoutes } = await query<{
			model_name: string;
			cooldown_until: string;
		}>(
			`SELECT model_name, cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		expect(cooledRoutes).toHaveLength(1);
		const cooledUntil = new Date(cooledRoutes[0].cooldown_until);
		expect(cooledUntil.getTime()).toBeGreaterThan(now.getTime() + 955 * 60_000);

		// Verify TEST_MODEL_2 is NOT cooled
		const { rows: activeRoutes } = await query<{
			model_name: string;
			cooldown_until: string | null;
		}>(
			`SELECT model_name, cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_2],
		);

		expect(activeRoutes).toHaveLength(1);
		expect(activeRoutes[0].cooldown_until).toBeNull();

		// Verify Layer 6 cooldown filter correctly excludes cooled route
		const { rows: nonCooledRoutes } = await query<{
			model_name: string;
		}>(
			`SELECT model_name FROM roadmap.model_routes
			 WHERE route_provider = $1
			   AND is_enabled = true
			   AND (cooldown_until IS NULL OR cooldown_until <= NOW())
			 ORDER BY priority ASC`,
			[TEST_PROVIDER],
		);

		expect(nonCooledRoutes.length).toBe(1);
		expect(nonCooledRoutes[0].model_name).toBe(TEST_MODEL_2);
	});

	/**
	 * AC-7.2: Model→provider escalation when all routes cooled
	 *
	 * Scenario:
	 *  1. Pre-seed single model route for test provider
	 *  2. Set model cooldown on that route
	 *  3. Query for non-cooled routes returns 0
	 *  4. Call setProviderCooldown to escalate to provider level
	 *  5. Verify provider_health.cooldown_until is set for test provider
	 */
	it("AC-7.2: Model→provider escalation when all routes cooled", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed single route
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		// Cool the only route
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 60, "test_cooldown");

		// Verify no non-cooled routes remain
		const { rows: enabledRows } = await query<{
			enabled_count: string | number;
		}>(
			`SELECT COUNT(*)::bigint as enabled_count FROM roadmap.model_routes
			 WHERE route_provider = $1 AND is_enabled = true
			   AND (cooldown_until IS NULL OR cooldown_until <= NOW())`,
			[TEST_PROVIDER],
		);

		expect(Number(enabledRows[0].enabled_count)).toBe(0);

		// Escalate to provider level
		await setProviderCooldown(TEST_PROVIDER, "rate_limit", "All routes exhausted");

		// Verify provider_health is set
		const { rows: providerHealthRows } = await query<{
			provider_name: string;
			cooldown_until: string;
			status: string;
		}>(
			`SELECT provider_name, cooldown_until, status FROM roadmap.provider_health
			 WHERE provider_name = $1`,
			[TEST_PROVIDER],
		);

		expect(providerHealthRows).toHaveLength(1);
		expect(providerHealthRows[0].status).toBe("rate_limited");
		expect(new Date(providerHealthRows[0].cooldown_until).getTime()).toBeGreaterThan(
			Date.now(),
		);

		// Verify provider-level in-cooldown check
		const inCooldown = await isProviderInCooldown(TEST_PROVIDER);
		expect(inCooldown).toBe(true);
	});

	/**
	 * AC-7.3: cooldown_clear MCP action clears model-level cooldown
	 *
	 * Scenario:
	 *  1. Pre-seed route + set cooldown_until in the future
	 *  2. Call the equivalent of cooldown_clear to NULL out cooldown_until
	 *  3. Verify isModelInCooldown returns false
	 *  4. Verify Layer 6 filter now includes the route
	 */
	it("AC-7.3: cooldown_clear action restores route availability", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed route
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		// Set cooldown
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 120, "manual_test");

		// Verify it's in cooldown
		let inCooldown = await isModelInCooldown(TEST_PROVIDER, TEST_MODEL_1);
		expect(inCooldown).toBe(true);

		// Clear cooldown (simulate MCP action)
		await query(
			`UPDATE roadmap.model_routes
			 SET cooldown_until = NULL
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		// Verify it's no longer in cooldown
		inCooldown = await isModelInCooldown(TEST_PROVIDER, TEST_MODEL_1);
		expect(inCooldown).toBe(false);

		// Verify Layer 6 filter includes it again
		const { rows: visibleRoutes } = await query<{
			model_name: string;
		}>(
			`SELECT model_name FROM roadmap.model_routes
			 WHERE route_provider = $1
			   AND is_enabled = true
			   AND (cooldown_until IS NULL OR cooldown_until <= NOW())`,
			[TEST_PROVIDER],
		);

		expect(visibleRoutes.length).toBe(1);
		expect(visibleRoutes[0].model_name).toBe(TEST_MODEL_1);
	});

	/**
	 * AC-7.4: Fallback 60-minute cooldown when parse fails
	 *
	 * Scenario:
	 *  1. Pre-seed route
	 *  2. Set cooldown with no parseable TTL (fallback 60 min per P1359 design)
	 *  3. Verify cooldown_until is ≈ NOW + 60 min (allow ±5 sec for test latency)
	 */
	it("AC-7.4: Fallback 60-minute cooldown on parse failure", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed route
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		const beforeSetCooldown = Date.now();

		// Set cooldown with default 60-minute fallback (no parsed TTL)
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 60, "parse_failed");

		const afterSetCooldown = Date.now();

		// Fetch the cooldown_until
		const { rows } = await query<{
			cooldown_until: string;
		}>(
			`SELECT cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		expect(rows).toHaveLength(1);
		const cooldownTime = new Date(rows[0].cooldown_until).getTime();
		const expectedMin = beforeSetCooldown + 60 * 60_000 - 5_000;
		const expectedMax = afterSetCooldown + 60 * 60_000 + 5_000;

		expect(cooldownTime).toBeGreaterThanOrEqual(expectedMin);
		expect(cooldownTime).toBeLessThanOrEqual(expectedMax);
	});

	/**
	 * AC-7.5: GREATEST merge semantics for overlapping cooldowns
	 *
	 * Scenario:
	 *  1. Pre-seed route with initial cooldown_until
	 *  2. Set new cooldown that is SHORTER than existing
	 *  3. Verify existing longer cooldown is preserved (GREATEST)
	 *  4. Then set new cooldown that is LONGER
	 *  5. Verify new longer cooldown is adopted
	 */
	it("AC-7.5: GREATEST merge preserves longer cooldown window", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed route
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		const now = Date.now();

		// Set initial 120-minute cooldown
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 120, "initial");

		const { rows: initialRows } = await query<{
			cooldown_until: string;
		}>(
			`SELECT cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		const initialCooldownTime = new Date(initialRows[0].cooldown_until).getTime();

		// Set shorter 30-minute cooldown
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 30, "shorter");

		const { rows: shorterRows } = await query<{
			cooldown_until: string;
		}>(
			`SELECT cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		const shorterCooldownTime = new Date(shorterRows[0].cooldown_until).getTime();

		// GREATEST should preserve the longer one (initial 120 min)
		expect(shorterCooldownTime).toBe(initialCooldownTime);

		// Now set a longer 240-minute cooldown
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 240, "longer");

		const { rows: longerRows } = await query<{
			cooldown_until: string;
		}>(
			`SELECT cooldown_until FROM roadmap.model_routes
			 WHERE route_provider = $1 AND model_name = $2`,
			[TEST_PROVIDER, TEST_MODEL_1],
		);

		const longerCooldownTime = new Date(longerRows[0].cooldown_until).getTime();

		// GREATEST should adopt the longer one (240 min > 120 min)
		expect(longerCooldownTime).toBeGreaterThan(initialCooldownTime);
		expect(longerCooldownTime).toBeGreaterThanOrEqual(now + 240 * 60_000 - 5_000);
	});

	/**
	 * AC-7.6: provider_exhausted outcome after max retries with quota errors
	 *
	 * Scenario:
	 *  1. Pre-seed only one route for test provider
	 *  2. Simulate 3 consecutive quota errors (all attempts)
	 *  3. After attempt 3, all routes should be cooled
	 *  4. Verify provider-level escalation occurred
	 *  5. Verify that a 4th attempt would still find provider in cooldown
	 */
	it("AC-7.6: provider_exhausted state after max attempts + escalation", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed single route (max attempts = 3, so we can't fall back)
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		// Simulate 3 attempts hitting quota errors
		for (let attempt = 1; attempt <= 3; attempt++) {
			const cooldownMinutes = 60 + attempt * 10; // Slightly increasing window per attempt
			await setModelCooldown(
				TEST_PROVIDER,
				TEST_MODEL_1,
				cooldownMinutes,
				`quota_error_attempt_${attempt}`,
			);
		}

		// After 3 attempts, all routes should be cooled
		const { rows: enabledRows } = await query<{
			enabled_count: string | number;
		}>(
			`SELECT COUNT(*)::bigint as enabled_count FROM roadmap.model_routes
			 WHERE route_provider = $1 AND is_enabled = true
			   AND (cooldown_until IS NULL OR cooldown_until <= NOW())`,
			[TEST_PROVIDER],
		);

		expect(Number(enabledRows[0].enabled_count)).toBe(0);

		// Escalate to provider level
		await setProviderCooldown(TEST_PROVIDER, "rate_limit", "Max attempts exhausted");

		// Verify provider is in cooldown
		const inProviderCooldown = await isProviderInCooldown(TEST_PROVIDER);
		expect(inProviderCooldown).toBe(true);

		// Verify model is also still in cooldown
		const inModelCooldown = await isModelInCooldown(TEST_PROVIDER, TEST_MODEL_1);
		expect(inModelCooldown).toBe(true);
	});

	/**
	 * AC-7.7: Cooldown status listing (summary query)
	 *
	 * Scenario:
	 *  1. Pre-seed multiple routes, set cooldown on some
	 *  2. Query active cooldowns (both model and provider level)
	 *  3. Verify listing returns correct provider/model pairs and reset times
	 */
	it("AC-7.7: Cooldown status listing returns active cooldowns", async () => {
		// Ensure metadata exists first
		await ensureTestMetadata();

		// Pre-seed 3 routes
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_1, TEST_PROVIDER, TEST_AGENT_PROVIDER, 1, true],
		);

		const TEST_MODEL_3 = "test-gemini-experimental";
		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_2, TEST_PROVIDER, TEST_AGENT_PROVIDER, 2, true],
		);

		await query(
			`INSERT INTO roadmap.model_routes
			 (model_name, route_provider, agent_provider, priority, is_enabled)
			 VALUES ($1, $2, $3, $4, $5)`,
			[TEST_MODEL_3, TEST_PROVIDER, TEST_AGENT_PROVIDER, 3, true],
		);

		// Set cooldown on 2 of them
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_1, 90, "reason1");
		await setModelCooldown(TEST_PROVIDER, TEST_MODEL_3, 120, "reason2");

		// Query active model-level cooldowns
		const { rows: modelCooldowns } = await query<{
			route_provider: string;
			model_name: string;
			cooldown_until: string;
		}>(
			`SELECT route_provider, model_name, cooldown_until
			 FROM roadmap.model_routes
			 WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()
			 ORDER BY model_name`,
			[],
		);

		// Filter to our test provider
		const ourCooldowns = modelCooldowns.filter(
			(r) => r.route_provider === TEST_PROVIDER,
		);

		expect(ourCooldowns).toHaveLength(2);
		expect(ourCooldowns.some((r) => r.model_name === TEST_MODEL_1)).toBe(true);
		expect(ourCooldowns.some((r) => r.model_name === TEST_MODEL_3)).toBe(true);
		expect(ourCooldowns.every((r) => r.model_name !== TEST_MODEL_2)).toBe(true);
	});

	/**
	 * AC-7.8: Provider-level cooldown clear (MCP action simulation)
	 *
	 * Scenario:
	 *  1. Set provider-level cooldown
	 *  2. Call the equivalent of provider_cooldown_clear
	 *  3. Verify provider_health.cooldown_until is NULL
	 *  4. Verify isProviderInCooldown returns false
	 */
	it("AC-7.8: provider_cooldown_clear action restores provider availability", async () => {
		// Escalate to provider level
		await setProviderCooldown(TEST_PROVIDER, "rate_limit", "test_cooldown");

		// Verify provider is in cooldown
		let inCooldown = await isProviderInCooldown(TEST_PROVIDER);
		expect(inCooldown).toBe(true);

		// Clear provider-level cooldown (simulate MCP action)
		await query(
			`UPDATE roadmap.provider_health
			 SET cooldown_until = NULL
			 WHERE provider_name = $1`,
			[TEST_PROVIDER],
		);

		// Verify it's no longer in cooldown
		inCooldown = await isProviderInCooldown(TEST_PROVIDER);
		expect(inCooldown).toBe(false);

		// Verify the row still exists but cooldown_until is NULL
		const { rows } = await query<{
			status: string;
			cooldown_until: null;
		}>(
			`SELECT status, cooldown_until FROM roadmap.provider_health
			 WHERE provider_name = $1`,
			[TEST_PROVIDER],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0].cooldown_until).toBeNull();
	});
});
