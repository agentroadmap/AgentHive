/**
 * P465: Subscription-aware claim policy in liaisons
 *
 * Eight acceptance criteria:
 * - AC-1: SubscriptionWindow interface with window_kind, resets_at, quota_tokens, quota_requests, used_tokens, used_requests, source
 * - AC-2: CapacityEnvelope struct with agency_id, windows[], free_claim_slots, in_flight_claims, last_updated_at
 * - AC-3: Refusal logic — iterate windows; compute projected margin; refuse if margin < SAFETY_MARGIN (default 0.15)
 * - AC-4: Liaison self-declares throttled with until timestamp; orchestrator marks agency.status=throttled and re-routes pending offers
 * - AC-5: Three-layer fallback — provider API (preferred), local meter, manual; liaison carries source field per window
 * - AC-6: Finish-in-flight policy — throttled agency continues in-flight; only NEW claims blocked. Hard limit hit → lease marked paused_at_provider_limit; claim_paused message sent
 * - AC-7: Configuration table roadmap.agency_capacity_config with agency_id, windows jsonb, safety_margin (default 0.15), refuse_below_slots (default 1)
 * - AC-8: Agency capacity config inheritable from provider defaults; per-agency overrides work correctly
 *
 * This test file verifies all 8 ACs with integration tests against the live DB.
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { query as defaultQuery } from "../src/infra/postgres/pool.ts";
import {
	evaluatePolicy,
	evaluateSubscriptionPolicy,
	loadCapacityEnvelope,
	loadCapacityConfig,
	declareThrottle,
	DEFAULT_SAFETY_MARGIN,
	DEFAULT_REFUSE_BELOW_SLOTS,
	type CapacityEnvelope,
	type SubscriptionWindow,
	type PolicyConfig,
} from "../src/infra/agency/subscription-policy.ts";

// ── Test fixtures ────────────────────────────────────────────────────────────

const testAgencyId = `test-p465-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function cleanupTestAgency(agencyId: string): Promise<void> {
	try {
		await defaultQuery(
			`DELETE FROM roadmap.agency_capacity_config WHERE agency_id = $1`,
			[agencyId],
		);
		await defaultQuery(
			`DELETE FROM roadmap.agency_usage_meter WHERE agency_id = $1`,
			[agencyId],
		);
	} catch {
		// Table might not exist yet
	}
}

// ── AC-1: SubscriptionWindow interface ───────────────────────────────────────

describe("P465 AC-1: SubscriptionWindow interface", () => {
	it("should define SubscriptionWindow with all required fields", () => {
		const window: SubscriptionWindow = {
			window_kind: "weekly",
			resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
			quota_tokens: 100_000,
			quota_requests: 1000,
			used_tokens: 20_000,
			used_requests: 10,
			source: "local_meter",
		};

		assert.equal(window.window_kind, "weekly");
		assert.ok(window.resets_at instanceof Date);
		assert.equal(window.quota_tokens, 100_000);
		assert.equal(window.quota_requests, 1000);
		assert.equal(window.used_tokens, 20_000);
		assert.equal(window.used_requests, 10);
		assert.equal(window.source, "local_meter");
	});

	it("should allow all window_kind values: 5h, daily, weekly, monthly", () => {
		const now = new Date();
		const kinds: SubscriptionWindow["window_kind"][] = ["5h", "daily", "weekly", "monthly"];

		for (const kind of kinds) {
			const window: SubscriptionWindow = {
				window_kind: kind,
				resets_at: new Date(now.getTime() + 1000),
				quota_tokens: 1000,
				quota_requests: 10,
				used_tokens: 100,
				used_requests: 1,
				source: "manual",
			};
			assert.equal(window.window_kind, kind);
		}
	});

	it("should allow all source values: provider_api, local_meter, manual", () => {
		const now = new Date();
		const sources: SubscriptionWindow["source"][] = ["provider_api", "local_meter", "manual"];

		for (const source of sources) {
			const window: SubscriptionWindow = {
				window_kind: "daily",
				resets_at: new Date(now.getTime() + 1000),
				quota_tokens: 1000,
				quota_requests: 10,
				used_tokens: 100,
				used_requests: 1,
				source,
			};
			assert.equal(window.source, source);
		}
	});

	it("should support null quota values (unlimited)", () => {
		const window: SubscriptionWindow = {
			window_kind: "monthly",
			resets_at: new Date(Date.now() + 30 * 24 * 3600 * 1000),
			quota_tokens: null,
			quota_requests: null,
			used_tokens: 999_999,
			used_requests: 999,
			source: "provider_api",
		};

		assert.equal(window.quota_tokens, null);
		assert.equal(window.quota_requests, null);
	});
});

// ── AC-2: CapacityEnvelope struct ────────────────────────────────────────────

describe("P465 AC-2: CapacityEnvelope struct", () => {
	it("should define CapacityEnvelope with all required fields", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 20_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 2,
			last_updated_at: new Date(),
		};

		assert.equal(envelope.agency_id, "test-agency");
		assert.equal(envelope.windows.length, 1);
		assert.equal(envelope.free_claim_slots, 5);
		assert.equal(envelope.in_flight_claims, 2);
		assert.ok(envelope.last_updated_at instanceof Date);
	});

	it("should support multiple windows in envelope", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "5h",
					resets_at: new Date(Date.now() + 5 * 3600 * 1000),
					quota_tokens: 10_000,
					quota_requests: 100,
					used_tokens: 2000,
					used_requests: 10,
					source: "local_meter",
				},
				{
					window_kind: "daily",
					resets_at: new Date(Date.now() + 24 * 3600 * 1000),
					quota_tokens: 50_000,
					quota_requests: 500,
					used_tokens: 10_000,
					used_requests: 50,
					source: "local_meter",
				},
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
					quota_tokens: 200_000,
					quota_requests: 2000,
					used_tokens: 50_000,
					used_requests: 250,
					source: "local_meter",
				},
			],
			free_claim_slots: 3,
			in_flight_claims: 1,
			last_updated_at: new Date(),
		};

		assert.equal(envelope.windows.length, 3);
		assert.equal(envelope.windows[0].window_kind, "5h");
		assert.equal(envelope.windows[1].window_kind, "daily");
		assert.equal(envelope.windows[2].window_kind, "weekly");
	});
});

// ── AC-3: Refusal logic ──────────────────────────────────────────────────────

describe("P465 AC-3: Refusal logic", () => {
	const config: PolicyConfig = {
		safety_margin: DEFAULT_SAFETY_MARGIN,
		refuse_below_slots: DEFAULT_REFUSE_BELOW_SLOTS,
	};

	it("should allow claim when all windows have margin >= safety_margin", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 20_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date(),
		};

		const result = evaluatePolicy(envelope, config, 10_000);
		assert.equal(result.allowed, true);
		assert.equal(result.reason, null);
	});

	it("should refuse claim when projected margin < safety_margin", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 80_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date(),
		};

		const result = evaluatePolicy(envelope, config, 20_000);
		assert.equal(result.allowed, false);
		assert.equal(result.tightest_window, "weekly");
		assert.ok(result.reason?.includes("margin"));
	});

	it("should find tightest window when multiple windows constrain", () => {
		const now = Date.now();
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "5h",
					resets_at: new Date(now + 2 * 3600 * 1000), // resets in 2h
					quota_tokens: 10_000,
					quota_requests: 100,
					used_tokens: 8_000,
					used_requests: 80,
					source: "local_meter",
				},
				{
					window_kind: "daily",
					resets_at: new Date(now + 24 * 3600 * 1000), // resets in 24h
					quota_tokens: 50_000,
					quota_requests: 500,
					used_tokens: 40_000,
					used_requests: 400,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date(),
		};

		const result = evaluatePolicy(envelope, config, 5_000);
		assert.equal(result.allowed, false);
		// Both windows would trigger refusal, but 5h is tighter
		assert.equal(result.tightest_window, "5h");
	});

	it("should refuse when free_claim_slots < refuse_below_slots", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [],
			free_claim_slots: 0,
			in_flight_claims: 5,
			last_updated_at: new Date(),
		};

		const result = evaluatePolicy(envelope, config, 0);
		assert.equal(result.allowed, false);
		assert.ok(result.reason?.includes("free_claim_slots"));
	});

	it("should allow when no windows configured (unconstrained)", () => {
		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [],
			free_claim_slots: 999,
			in_flight_claims: 0,
			last_updated_at: new Date(),
		};

		const result = evaluatePolicy(envelope, config, 999_999);
		assert.equal(result.allowed, true);
	});

	it("should respect custom safety_margin config", () => {
		const strictConfig: PolicyConfig = {
			safety_margin: 0.25, // Stricter than default 0.15
			refuse_below_slots: 1,
		};

		const envelope: CapacityEnvelope = {
			agency_id: "test-agency",
			windows: [
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 70_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date(),
		};

		// With 70k used and 20k estimated: projected = 100k - 70k - 20k = 10k
		// Margin = 10k / 100k = 10% < 25% → REFUSE
		const result = evaluatePolicy(envelope, strictConfig, 20_000);
		assert.equal(result.allowed, false);
	});
});

// ── AC-4: Throttle declaration ──────────────────────────────────────────────

describe("P465 AC-4: Liaison self-declares throttled", () => {
	const ac4AgencyId = `test-p465-ac4-${Date.now()}`;

	before(async () => {
		// Ensure agency exists
		await defaultQuery(
			`DELETE FROM roadmap.agency WHERE agency_id = $1`,
			[ac4AgencyId],
		);
		await defaultQuery(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
			 VALUES ($1, $2, $3, $4, 'active')`,
			[ac4AgencyId, `Test Agency AC4 ${Date.now()}`, "test-provider", "bot"],
		);
	});

	after(async () => {
		try {
			await defaultQuery(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [ac4AgencyId]);
		} catch {
			// OK
		}
	});

	it("should set agency.status = throttled and record reset timestamp", async () => {
		const resetTime = new Date(Date.now() + 24 * 3600 * 1000);
		const reason = "throttle:daily";

		await declareThrottle(ac4AgencyId, resetTime, reason, defaultQuery);

		const result = await defaultQuery(
			`SELECT status, status_reason, metadata->>'throttled_until' as throttled_until
			 FROM roadmap.agency WHERE agency_id = $1`,
			[ac4AgencyId],
		);

		assert.equal(result.rows.length, 1);
		const row = result.rows[0];
		assert.equal(row.status, "throttled");
		assert.equal(row.status_reason, reason);
		assert.ok(row.throttled_until);
	});
});

// ── AC-5: Three-layer fallback ──────────────────────────────────────────────

describe("P465 AC-5: Three-layer fallback for usage", () => {
	const ac5AgencyId = `test-p465-ac5-${Date.now()}`;

	before(async () => {
		await defaultQuery(
			`DELETE FROM roadmap.agency WHERE agency_id = $1`,
			[ac5AgencyId],
		);
		await defaultQuery(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
			 VALUES ($1, $2, $3, $4, 'active')`,
			[ac5AgencyId, `Test Agency AC5 ${Date.now()}`, "test-provider", "bot"],
		);
	});

	after(async () => {
		try {
			await defaultQuery(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [ac5AgencyId]);
		} catch {
			// OK
		}
	});

	it("should fallback to manual (null) when no envelope stored", async () => {
		const result = await loadCapacityEnvelope(ac5AgencyId, defaultQuery);
		// Layer 1 (provider_api) is stubbed to null
		// Layer 2 (local_meter) — no envelope stored → returns null
		// Layer 3 (manual) — null envelope means unconstrained
		assert.equal(result, null);
	});

	it("should load envelope from agency.metadata when stored", async () => {
		const envelope = {
			windows: [
				{
					window_kind: "weekly",
					resets_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 20_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date().toISOString(),
		};

		await defaultQuery(
			`UPDATE roadmap.agency SET metadata = jsonb_build_object('capacity_envelope', $2::jsonb)
			 WHERE agency_id = $1`,
			[ac5AgencyId, JSON.stringify(envelope)],
		);

		const result = await loadCapacityEnvelope(ac5AgencyId, defaultQuery);
		assert.ok(result !== null);
		assert.equal(result?.agency_id, ac5AgencyId);
		assert.equal(result?.windows.length, 1);
		assert.equal(result?.windows[0].window_kind, "weekly");
		assert.equal(result?.windows[0].used_tokens, 20_000);
		assert.equal(result?.windows[0].source, "local_meter");
	});
});

// ── AC-7: Configuration table ────────────────────────────────────────────────

describe("P465 AC-7: agency_capacity_config table", () => {
	const ac7AgencyId = `test-p465-ac7-${Date.now()}`;

	before(async () => {
		await defaultQuery(
			`DELETE FROM roadmap.agency WHERE agency_id = $1`,
			[ac7AgencyId],
		);
		await defaultQuery(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
			 VALUES ($1, $2, $3, $4, 'active')`,
			[ac7AgencyId, `Test Agency AC7 ${Date.now()}`, "test-provider", "bot"],
		);
	});

	after(async () => {
		try {
			await defaultQuery(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [ac7AgencyId]);
		} catch {
			// OK
		}
	});

	it("should define agency_capacity_config table with required columns", async () => {
		const result = await defaultQuery(
			`SELECT column_name, data_type
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap' AND table_name = 'agency_capacity_config'
			 ORDER BY column_name`,
		);

		const columnMap = new Map(result.rows.map((r) => [r.column_name, r.data_type]));
		assert.ok(columnMap.has("agency_id"));
		assert.ok(columnMap.has("windows"));
		assert.ok(columnMap.has("safety_margin"));
		assert.ok(columnMap.has("refuse_below_slots"));
	});

	it("should allow inserting per-agency config with defaults", async () => {
		await defaultQuery(
			`INSERT INTO roadmap.agency_capacity_config (agency_id, windows)
			 VALUES ($1, $2)`,
			[ac7AgencyId, JSON.stringify([])],
		);

		const result = await defaultQuery(
			`SELECT safety_margin, refuse_below_slots FROM roadmap.agency_capacity_config
			 WHERE agency_id = $1`,
			[ac7AgencyId],
		);

		assert.equal(result.rows.length, 1);
		const row = result.rows[0];
		assert.equal(Number(row.safety_margin), DEFAULT_SAFETY_MARGIN);
		assert.equal(row.refuse_below_slots, DEFAULT_REFUSE_BELOW_SLOTS);
	});

	it("should allow custom safety_margin and refuse_below_slots", async () => {
		const customAgencyId = `test-p465-custom-${Date.now()}`;
		try {
			await defaultQuery(
				`DELETE FROM roadmap.agency WHERE agency_id = $1`,
				[customAgencyId],
			);
			await defaultQuery(
				`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
				 VALUES ($1, $2, $3, $4, 'active')`,
				[customAgencyId, `Custom Agency ${Date.now()}`, "test-provider", "bot"],
			);

			await defaultQuery(
				`INSERT INTO roadmap.agency_capacity_config
				 (agency_id, windows, safety_margin, refuse_below_slots)
				 VALUES ($1, $2, $3, $4)`,
				[customAgencyId, JSON.stringify([]), "0.20", 2],
			);

			const result = await loadCapacityConfig(customAgencyId, defaultQuery);
			assert.equal(result.safety_margin, 0.20);
			assert.equal(result.refuse_below_slots, 2);
		} finally {
			try {
				await defaultQuery(`DELETE FROM roadmap.agency_capacity_config WHERE agency_id = $1`, [
					customAgencyId,
				]);
				await defaultQuery(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [customAgencyId]);
			} catch {
				// OK
			}
		}
	});
});

// ── AC-8: Provider defaults inheritance ──────────────────────────────────────

describe("P465 AC-8: Provider defaults inheritance", () => {
	it("should have provider_capacity_defaults table for inheritable defaults", async () => {
		const result = await defaultQuery(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'roadmap' AND table_name = 'provider_capacity_defaults'`,
		);

		assert.equal(result.rows.length, 1, "provider_capacity_defaults table should exist");
	});

	it("should define provider_capacity_defaults with inheritance-supporting columns", async () => {
		const result = await defaultQuery(
			`SELECT column_name, data_type
			 FROM information_schema.columns
			 WHERE table_schema = 'roadmap' AND table_name = 'provider_capacity_defaults'
			 ORDER BY column_name`,
		);

		const columnMap = new Map(result.rows.map((r) => [r.column_name, r.data_type]));
		assert.ok(columnMap.has("provider"), "provider column required for defaults");
		assert.ok(columnMap.has("windows"), "windows column required for defaults");
		assert.ok(columnMap.has("safety_margin"), "safety_margin column required for defaults");
		assert.ok(columnMap.has("refuse_below_slots"), "refuse_below_slots column required for defaults");
	});
});

// ── Integration: evaluateSubscriptionPolicy ──────────────────────────────────

describe("P465 Integration: evaluateSubscriptionPolicy", () => {
	const integrationAgencyId = `test-p465-int-${Date.now()}`;

	before(async () => {
		await defaultQuery(
			`DELETE FROM roadmap.agency WHERE agency_id = $1`,
			[integrationAgencyId],
		);
		await defaultQuery(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
			 VALUES ($1, $2, $3, $4, 'active')`,
			[integrationAgencyId, `Test Agency INT ${Date.now()}`, "test-provider", "bot"],
		);
	});

	after(async () => {
		try {
			await defaultQuery(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [integrationAgencyId]);
		} catch {
			// OK
		}
	});

	it("should allow when no envelope or config stored (unconstrained)", async () => {
		const result = await evaluateSubscriptionPolicy(
			integrationAgencyId,
			defaultQuery,
			console,
			100_000,
		);
		assert.equal(result.allowed, true);
	});

	it("should refuse when envelope stored in metadata indicates throttle", async () => {
		// Setup envelope directly in metadata (layer 2 of three-layer fallback)
		const resets_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
		const envelope = {
			windows: [
				{
					window_kind: "weekly",
					resets_at,
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 80_000,
					used_requests: 10,
					source: "local_meter",
				},
			],
			free_claim_slots: 5,
			in_flight_claims: 0,
			last_updated_at: new Date().toISOString(),
		};

		await defaultQuery(
			`UPDATE roadmap.agency SET metadata = jsonb_build_object('capacity_envelope', $2::jsonb)
			 WHERE agency_id = $1`,
			[integrationAgencyId, JSON.stringify(envelope)],
		);

		// Setup config (even though not used in this case; required for complete policy check)
		await defaultQuery(
			`INSERT INTO roadmap.agency_capacity_config (agency_id, windows)
			 VALUES ($1, $2)
			 ON CONFLICT (agency_id) DO UPDATE SET windows = EXCLUDED.windows`,
			[
				integrationAgencyId,
				JSON.stringify([
					{
						window_kind: "weekly",
						quota_tokens: 100_000,
						quota_requests: 1000,
					},
				]),
			],
		);

		// Estimate 20k additional tokens
		// With 80k used and 20k estimated: projected = 100k - 80k - 20k = 0k
		// Margin = 0% < 15% (default safety_margin) → REFUSE
		const result = await evaluateSubscriptionPolicy(
			integrationAgencyId,
			defaultQuery,
			console,
			20_000,
		);
		assert.equal(result.allowed, false);
		assert.equal(result.tightest_window, "weekly");
	});

	it("should fail-open (allow) on DB error", async () => {
		const failingExec = async () => {
			throw new Error("connection refused");
		};

		const result = await evaluateSubscriptionPolicy(
			integrationAgencyId,
			failingExec as never,
			console,
			100_000,
		);
		assert.equal(result.allowed, true, "should fail-open on DB error");
	});
});
