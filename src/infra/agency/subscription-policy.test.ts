/**
 * P465: Unit tests for subscription-policy — pure evaluations and mocked DB paths.
 * No real DB / spawn. Verifies the mechanical contract: weekly quota 100k tokens
 * with 20k-token jobs is refused on the 5th claim (margin drops below 15%).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
	evaluatePolicy,
	loadCapacityEnvelope,
	loadCapacityConfig,
	evaluateSubscriptionPolicy,
	computeWindowStart,
	computeWindowResetAt,
	checkCapacityBeforeClaim,
	DEFAULT_SAFETY_MARGIN,
	DEFAULT_REFUSE_BELOW_SLOTS,
	type CapacityEnvelope,
	type PolicyConfig,
} from "./subscription-policy.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function silentLogger(): Pick<Console, "log" | "warn" | "error"> {
	return { log: () => {}, warn: () => {}, error: () => {} };
}

function weeklyWindow(usedTokens: number): CapacityEnvelope["windows"][0] {
	const resets = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
	return {
		window_kind: "weekly",
		resets_at: resets,
		quota_tokens: 100_000,
		quota_requests: 1000,
		used_tokens: usedTokens,
		used_requests: 0,
		source: "local_meter",
	};
}

function makeEnvelope(usedTokens: number): CapacityEnvelope {
	return {
		agency_id: "test-agency",
		windows: [weeklyWindow(usedTokens)],
		free_claim_slots: 999,
		in_flight_claims: 0,
		last_updated_at: new Date(),
	};
}

const strictConfig: PolicyConfig = {
	safety_margin: DEFAULT_SAFETY_MARGIN,
	refuse_below_slots: DEFAULT_REFUSE_BELOW_SLOTS,
};

// ── AC-7/AC-8: 100k weekly quota × 20k token jobs — refuse at 5th claim ──────

test("evaluatePolicy: allows claims 1–4 on 100k weekly quota (20k each)", () => {
	// After 0 jobs: margin = (100k - 20k) / 100k = 80% → ALLOW
	assert.equal(evaluatePolicy(makeEnvelope(0), strictConfig, 20_000).allowed, true, "1st claim");
	// After 1 job (20k used): margin = (100k - 20k - 20k) / 100k = 60% → ALLOW
	assert.equal(evaluatePolicy(makeEnvelope(20_000), strictConfig, 20_000).allowed, true, "2nd claim");
	// After 2 jobs (40k used): margin = (60k - 20k) / 100k = 40% → ALLOW
	assert.equal(evaluatePolicy(makeEnvelope(40_000), strictConfig, 20_000).allowed, true, "3rd claim");
	// After 3 jobs (60k used): margin = (40k - 20k) / 100k = 20% > 15% → ALLOW
	assert.equal(evaluatePolicy(makeEnvelope(60_000), strictConfig, 20_000).allowed, true, "4th claim");
	// After 4 jobs (80k used): margin = (20k - 20k) / 100k = 0% < 15% → REFUSE
	const result = evaluatePolicy(makeEnvelope(80_000), strictConfig, 20_000);
	assert.equal(result.allowed, false, "5th claim must be refused");
	assert.equal(result.tightest_window, "weekly");
	assert.ok(result.resets_at instanceof Date);
	assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("evaluatePolicy: allows when exactly at safety margin boundary", () => {
	// Used 85k, estimating 20k → projected remaining = 100k - 85k - 20k = -5k → margin = -5% < 15% → REFUSE
	assert.equal(evaluatePolicy(makeEnvelope(85_000), strictConfig, 20_000).allowed, false);
	// Used 83k, estimating 20k → projected = 100k - 83k - 20k = -3k → margin = -3% < 15% → REFUSE
	assert.equal(evaluatePolicy(makeEnvelope(83_000), strictConfig, 20_000).allowed, false);
	// Used 63k, estimating 20k → projected = 100k - 63k - 20k = 17k → margin = 17% > 15% → ALLOW
	assert.equal(evaluatePolicy(makeEnvelope(63_000), strictConfig, 20_000).allowed, true);
});

test("evaluatePolicy: allows when quota_tokens is null (unlimited)", () => {
	const envelope: CapacityEnvelope = {
		agency_id: "test-agency",
		windows: [{
			window_kind: "weekly",
			resets_at: new Date(Date.now() + 1000),
			quota_tokens: null,
			quota_requests: null,
			used_tokens: 99_999,
			used_requests: 0,
			source: "local_meter",
		}],
		free_claim_slots: 5,
		in_flight_claims: 0,
		last_updated_at: new Date(),
	};
	assert.equal(evaluatePolicy(envelope, strictConfig, 20_000).allowed, true);
});

test("evaluatePolicy: refuses when free_claim_slots below floor", () => {
	const envelope = makeEnvelope(0);
	envelope.free_claim_slots = 0;
	const result = evaluatePolicy(envelope, { safety_margin: 0.15, refuse_below_slots: 1 }, 0);
	assert.equal(result.allowed, false);
	assert.ok(result.reason?.includes("free_claim_slots"));
});

test("evaluatePolicy: allows when no windows configured", () => {
	const envelope: CapacityEnvelope = {
		agency_id: "test-agency",
		windows: [],
		free_claim_slots: 999,
		in_flight_claims: 0,
		last_updated_at: new Date(),
	};
	assert.equal(evaluatePolicy(envelope, strictConfig, 20_000).allowed, true);
});

// ── loadCapacityConfig ────────────────────────────────────────────────────────

test("loadCapacityConfig: returns per-agency override from DB", async () => {
	const exec = async (_sql: string, _params?: unknown[]) => ({
		rows: [{ safety_margin: 0.2, refuse_below_slots: 2 }],
	});
	const config = await loadCapacityConfig("test-agency", exec as never);
	assert.equal(config.safety_margin, 0.2);
	assert.equal(config.refuse_below_slots, 2);
});

test("loadCapacityConfig: returns defaults when no row found", async () => {
	const exec = async (_sql: string, _params?: unknown[]) => ({ rows: [] });
	const config = await loadCapacityConfig("test-agency", exec as never);
	assert.equal(config.safety_margin, DEFAULT_SAFETY_MARGIN);
	assert.equal(config.refuse_below_slots, DEFAULT_REFUSE_BELOW_SLOTS);
});

test("loadCapacityConfig: returns defaults on DB error", async () => {
	const exec = async () => { throw new Error("connection refused"); };
	const config = await loadCapacityConfig("test-agency", exec as never);
	assert.equal(config.safety_margin, DEFAULT_SAFETY_MARGIN);
	assert.equal(config.refuse_below_slots, DEFAULT_REFUSE_BELOW_SLOTS);
});

// ── loadCapacityEnvelope ──────────────────────────────────────────────────────

test("loadCapacityEnvelope: returns null when metadata has no capacity_envelope", async () => {
	const exec = async () => ({ rows: [{ envelope: null }] });
	const result = await loadCapacityEnvelope("test-agency", exec as never);
	assert.equal(result, null);
});

test("loadCapacityEnvelope: returns null on DB error (fail-open)", async () => {
	const exec = async () => { throw new Error("db gone"); };
	const result = await loadCapacityEnvelope("test-agency", exec as never);
	assert.equal(result, null);
});

test("loadCapacityEnvelope: parses envelope from JSONB", async () => {
	const resets_at = new Date(Date.now() + 3600_000).toISOString();
	const exec = async () => ({
		rows: [{
			envelope: {
				windows: [{
					window_kind: "weekly",
					resets_at,
					quota_tokens: 100_000,
					quota_requests: 1000,
					used_tokens: 80_000,
					used_requests: 4,
					source: "local_meter",
				}],
				free_claim_slots: 5,
				in_flight_claims: 1,
				last_updated_at: new Date().toISOString(),
			},
		}],
	});
	const result = await loadCapacityEnvelope("test-agency", exec as never);
	assert.ok(result !== null);
	assert.equal(result!.windows.length, 1);
	assert.equal(result!.windows[0].window_kind, "weekly");
	assert.equal(result!.windows[0].used_tokens, 80_000);
	assert.equal(result!.windows[0].quota_tokens, 100_000);
	assert.equal(result!.free_claim_slots, 5);
});

// ── evaluateSubscriptionPolicy (integration path) ────────────────────────────

test("evaluateSubscriptionPolicy: allowed=true when no envelope stored", async () => {
	const exec = async () => ({ rows: [] });
	const result = await evaluateSubscriptionPolicy("test-agency", exec as never, silentLogger());
	assert.equal(result.allowed, true);
});

test("evaluateSubscriptionPolicy: refuses when envelope shows 80k/100k used and 20k estimated", async () => {
	const resets_at = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
	const exec = async (sql: string) => {
		if (sql.includes("capacity_envelope")) {
			return {
				rows: [{
					envelope: {
						windows: [{
							window_kind: "weekly",
							resets_at,
							quota_tokens: 100_000,
							quota_requests: 1000,
							used_tokens: 80_000,
							used_requests: 4,
							source: "local_meter",
						}],
						free_claim_slots: 5,
						in_flight_claims: 0,
						last_updated_at: new Date().toISOString(),
					},
				}],
			};
		}
		// loadCapacityConfig — return default
		return { rows: [] };
	};
	const result = await evaluateSubscriptionPolicy(
		"test-agency",
		exec as never,
		silentLogger(),
		20_000,
	);
	assert.equal(result.allowed, false);
	assert.equal(result.tightest_window, "weekly");
});

test("evaluateSubscriptionPolicy: fail-open on unexpected exec error", async () => {
	const exec = async () => { throw new Error("unexpected"); };
	const result = await evaluateSubscriptionPolicy("test-agency", exec as never, silentLogger());
	assert.equal(result.allowed, true);
});

// ── Window boundary helpers (consolidated from subscription-quota tests) ──────

test("computeWindowStart: 5h floors to current 5-hour boundary", () => {
	const t = new Date("2025-01-01T14:30:00Z"); // 14h → boundary 10h
	const s = computeWindowStart("5h", t);
	assert.equal(s.getUTCHours(), 10);
	assert.equal(s.getUTCMinutes(), 0);
	assert.equal(s.getUTCSeconds(), 0);
});

test("computeWindowStart: daily resets to midnight UTC", () => {
	const t = new Date("2025-06-15T17:45:00Z");
	const s = computeWindowStart("daily", t);
	assert.equal(s.toISOString(), "2025-06-15T00:00:00.000Z");
});

test("computeWindowStart: monthly resets to 1st of month", () => {
	const t = new Date("2025-06-20T12:00:00Z");
	const s = computeWindowStart("monthly", t);
	assert.equal(s.toISOString(), "2025-06-01T00:00:00.000Z");
});

test("computeWindowStart: weekly resets to Sunday (UTC)", () => {
	const t = new Date("2025-06-18T12:00:00Z");
	const s = computeWindowStart("weekly", t);
	assert.equal(s.toISOString(), "2025-06-15T00:00:00.000Z");
});

test("computeWindowResetAt: 5h next 5-hour boundary", () => {
	const t = new Date("2025-01-01T14:30:00Z");
	const r = computeWindowResetAt("5h", t);
	assert.equal(r.getUTCHours(), 15);
	assert.equal(r.getUTCMinutes(), 0);
});

test("computeWindowResetAt: daily midnight of next day", () => {
	const t = new Date("2025-06-15T17:45:00Z");
	assert.equal(computeWindowResetAt("daily", t).toISOString(), "2025-06-16T00:00:00.000Z");
});

test("computeWindowResetAt: monthly 1st of next month", () => {
	const t = new Date("2025-06-20T12:00:00Z");
	assert.equal(computeWindowResetAt("monthly", t).toISOString(), "2025-07-01T00:00:00.000Z");
});

test("computeWindowResetAt: weekly next Sunday", () => {
	const t = new Date("2025-06-18T12:00:00Z");
	assert.equal(computeWindowResetAt("weekly", t).toISOString(), "2025-06-22T00:00:00.000Z");
});

// ── checkCapacityBeforeClaim (consolidated from subscription-quota) ──────────

test("checkCapacityBeforeClaim: allows when no config exists (unconstrained)", async () => {
	const exec = async () => ({ rows: [] });
	const result = await checkCapacityBeforeClaim("agency-x", undefined, exec as never);
	assert.equal(result.allowed, true);
});

test("checkCapacityBeforeClaim: allows when projected margin >= safety_margin", async () => {
	// Mock exec for loadFullCapacityConfig + loadWindowUsage
	let callCount = 0;
	const exec = async (sql: string) => {
		callCount++;
		// First call: loadFullCapacityConfig for agency_capacity_config
		if (sql.includes("agency_capacity_config")) {
			return {
				rows: [{
					windows: [{ window_kind: "daily", quota_tokens: 1_000_000, quota_requests: 100 }],
					safety_margin: "0.15",
					refuse_below_slots: 1,
				}],
			};
		}
		// Subsequent calls: loadWindowUsage for agency_usage_meter
		return { rows: [{ used_tokens: "400000", used_requests: "5", source: "local_meter" }] };
	};
	const result = await checkCapacityBeforeClaim("agency-x", { tokens: 50_000, requests: 1 }, exec as never);
	assert.equal(result.allowed, true);
});

test("checkCapacityBeforeClaim: refuses when token margin < safety_margin", async () => {
	// Mock exec for loadFullCapacityConfig + loadWindowUsage
	const exec = async (sql: string) => {
		// First call: loadFullCapacityConfig for agency_capacity_config
		if (sql.includes("agency_capacity_config")) {
			return {
				rows: [{
					windows: [{ window_kind: "daily", quota_tokens: 1_000_000, quota_requests: 100 }],
					safety_margin: "0.15",
					refuse_below_slots: 1,
				}],
			};
		}
		// Subsequent calls: loadWindowUsage for agency_usage_meter
		return { rows: [{ used_tokens: "900000", used_requests: "5", source: "local_meter" }] };
	};
	const result = await checkCapacityBeforeClaim("agency-x", { tokens: 200_000, requests: 1 }, exec as never);
	assert.equal(result.allowed, false);
	assert.ok(result.refuse_reason?.includes("throttle:daily"));
	assert.ok(result.throttle_until instanceof Date);
});
