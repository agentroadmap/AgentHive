/**
 * P3787: Hardcoded-constant migration — runtime flag acceptance tests.
 *
 * AC-2  config-keys-default-parity: each new FlagKey.defaultValue == recorded original literal
 * AC-3  flag override changes value: DB row shadows the default
 * AC-4  NOTIFY live-reload: clearCache() (triggered by runtime_flag_changed) forces re-read
 * AC-5  validation bounds preserved: parse() throws for out-of-range / non-numeric inputs
 * AC-6  config-layer-unavailable fallback: resolver returns old literal when runtimeConfig.get throws
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	cleanup,
	clearCache,
	get,
	initConfig,
} from "../../src/shared/runtime/config.ts";
import { FlagKeys } from "../../src/shared/runtime/config-keys.ts";
import {
	DEFAULT_PROVIDER_HEALTH_TTL_MS,
	resolveProviderHealthTtlMs,
} from "../../src/core/provider-health/cache.ts";
import {
	resolveAgentProposalLeaseTtlMs,
} from "../../src/core/collaboration/agent-proposals.ts";

// ─── AC-2: Default parity ─────────────────────────────────────────────────────

describe("P3787 AC-2: config-keys-default-parity", () => {
	const EXPECTED: Array<[keyof typeof FlagKeys, number]> = [
		["DISPATCH_LOOP_THRESHOLD_PER_HOUR",  6],
		["GATE_CONVERGENCE_MAX_BLOCKING",      3],
		["GATE_CONVERGENCE_MAX_RUNS_PER_ROLE", 8],
		["FEDERATION_SYNC_POLL_INTERVAL_MS",   30_000],
		["FEDERATION_HEALTH_QUARANTINE_THRESHOLD", 3],
		["FEDERATION_PING_TIMEOUT_MS",         5_000],
		["SAGA_REPAIR_INTERVAL_MS",            60_000],
		["SAGA_REPAIR_MAX_ATTEMPTS",           10],
		["SAGA_REPAIR_MAX_BACKOFF_HOURS",      24],
		["NOTIFICATION_POLL_INTERVAL_MS",      30_000],
		["NOTIFICATION_BATCH_SIZE",            25],
		["PROVIDER_HEALTH_TTL_MS",             30_000],
		["AGENT_PROPOSAL_LEASE_TTL_MS",        1_800_000],
		["TRANSPORT_WAKE_TIMEOUT_MS",          10_000],
	];

	for (const [keyName, expected] of EXPECTED) {
		it(`${keyName}.defaultValue === ${expected}`, () => {
			const key = FlagKeys[keyName] as { defaultValue: unknown };
			assert.equal(
				key.defaultValue,
				expected,
				`${keyName}: expected defaultValue=${expected}, got ${key.defaultValue}`,
			);
		});
	}
});

// ─── AC-5: Validation bounds ──────────────────────────────────────────────────

describe("P3787 AC-5: validation bounds preserved", () => {
	it("DISPATCH_LOOP_THRESHOLD_PER_HOUR rejects 0 (< 1)", () => {
		assert.throws(
			() => FlagKeys.DISPATCH_LOOP_THRESHOLD_PER_HOUR.parse("0"),
			/Invalid DISPATCH_LOOP_THRESHOLD_PER_HOUR/,
		);
	});

	it("DISPATCH_LOOP_THRESHOLD_PER_HOUR rejects non-numeric string", () => {
		assert.throws(
			() => FlagKeys.DISPATCH_LOOP_THRESHOLD_PER_HOUR.parse('"abc"'),
			/Invalid/,
		);
	});

	it("FEDERATION_SYNC_POLL_INTERVAL_MS rejects 500 (< 1000 ms)", () => {
		assert.throws(
			() => FlagKeys.FEDERATION_SYNC_POLL_INTERVAL_MS.parse("500"),
			/Invalid FEDERATION_SYNC_POLL_INTERVAL_MS/,
		);
	});

	it("SAGA_REPAIR_INTERVAL_MS rejects 4999 (< 5000 ms)", () => {
		assert.throws(
			() => FlagKeys.SAGA_REPAIR_INTERVAL_MS.parse("4999"),
			/Invalid SAGA_REPAIR_INTERVAL_MS/,
		);
	});

	it("NOTIFICATION_BATCH_SIZE rejects 0 (< 1)", () => {
		assert.throws(
			() => FlagKeys.NOTIFICATION_BATCH_SIZE.parse("0"),
			/Invalid NOTIFICATION_BATCH_SIZE/,
		);
	});

	it("NOTIFICATION_BATCH_SIZE rejects 1001 (> 1000)", () => {
		assert.throws(
			() => FlagKeys.NOTIFICATION_BATCH_SIZE.parse("1001"),
			/Invalid NOTIFICATION_BATCH_SIZE/,
		);
	});

	it("AGENT_PROPOSAL_LEASE_TTL_MS rejects 59999 (< 60000 ms)", () => {
		assert.throws(
			() => FlagKeys.AGENT_PROPOSAL_LEASE_TTL_MS.parse("59999"),
			/Invalid AGENT_PROPOSAL_LEASE_TTL_MS/,
		);
	});

	it("TRANSPORT_WAKE_TIMEOUT_MS rejects 499 (< 500 ms)", () => {
		assert.throws(
			() => FlagKeys.TRANSPORT_WAKE_TIMEOUT_MS.parse("499"),
			/Invalid TRANSPORT_WAKE_TIMEOUT_MS/,
		);
	});

	it("PROVIDER_HEALTH_TTL_MS rejects 999 (< 1000 ms)", () => {
		assert.throws(
			() => FlagKeys.PROVIDER_HEALTH_TTL_MS.parse("999"),
			/Invalid PROVIDER_HEALTH_TTL_MS/,
		);
	});
});

// ─── AC-3, AC-4: Flag DB override + live-reload ───────────────────────────────

describe("P3787 AC-3 + AC-4: flag DB override and clearCache live-reload", () => {
	let queryResponses: Map<string, string>;

	function makeFakePool() {
		return {
			query: async (sql: string, params: any[]) => {
				if (/FROM core\.runtime_flag/.test(sql)) {
					const flagName = params[0] as string;
					const val = queryResponses.get(flagName);
					if (val !== undefined) {
						return { rows: [{ value_jsonb: val }] };
					}
					return { rows: [] };
				}
				// LISTEN / other queries
				return { rows: [] };
			},
			connect: async () => ({
				query: async () => ({ rows: [] }),
				on: () => {},
				release: () => {},
			}),
			on: () => {},
		} as any;
	}

	beforeEach(async () => {
		queryResponses = new Map();
		await initConfig({ pool: makeFakePool() });
	});

	afterEach(async () => {
		await cleanup();
	});

	it("AC-3: DB row overrides the defaultValue", async () => {
		queryResponses.set("PROVIDER_HEALTH_TTL_MS", "45000");

		const value = await get(FlagKeys.PROVIDER_HEALTH_TTL_MS);
		assert.equal(value, 45_000, "DB row should override the 30000 default");
	});

	it("AC-4: clearCache() forces re-read after runtime_flag_changed", async () => {
		queryResponses.set("PROVIDER_HEALTH_TTL_MS", "45000");
		const first = await get(FlagKeys.PROVIDER_HEALTH_TTL_MS);
		assert.equal(first, 45_000);

		// Simulate operator UPDATE + runtime_flag_changed notify → clears cache
		queryResponses.set("PROVIDER_HEALTH_TTL_MS", "60000");
		clearCache();

		const second = await get(FlagKeys.PROVIDER_HEALTH_TTL_MS);
		assert.equal(second, 60_000, "After cache clear, updated DB value should be returned");
	});

	it("AC-3: default returned when no DB row exists", async () => {
		// no entry in queryResponses → rows: []
		const value = await get(FlagKeys.PROVIDER_HEALTH_TTL_MS);
		assert.equal(value, 30_000, "Should fall through to defaultValue when no DB row");
	});

	it("AC-3: AGENT_PROPOSAL_LEASE_TTL_MS DB row overrides default", async () => {
		queryResponses.set("AGENT_PROPOSAL_LEASE_TTL_MS", "3600000");

		const value = await get(FlagKeys.AGENT_PROPOSAL_LEASE_TTL_MS);
		assert.equal(value, 3_600_000, "DB row (1h) should override the 30min default");
	});
});

// ─── AC-6: Config-layer-unavailable fallback ──────────────────────────────────

describe("P3787 AC-6: config-layer-unavailable fallback to historical default", () => {
	afterEach(async () => {
		await cleanup();
	});

	it("resolveProviderHealthTtlMs returns DEFAULT_PROVIDER_HEALTH_TTL_MS when config throws", async () => {
		// No initConfig → globalResolver is null → get() throws "Resolver not initialized"
		await cleanup();

		const result = await resolveProviderHealthTtlMs();
		assert.equal(
			result,
			DEFAULT_PROVIDER_HEALTH_TTL_MS,
			"Resolver must return the original hardcoded literal when config layer is unavailable",
		);
		assert.equal(result, 30_000);
	});

	it("resolveAgentProposalLeaseTtlMs returns 1_800_000 when config throws", async () => {
		await cleanup();

		const result = await resolveAgentProposalLeaseTtlMs();
		assert.equal(
			result,
			1_800_000,
			"Resolver must return the 30min original literal when config layer is unavailable",
		);
	});
});
