/**
 * P1699 Phase 3: capacity controller (AIMD) simulation tests.
 *
 * AC-1: effective-cap formula responds to the target_quota_pct knob.
 * AC-3: controller stays inert until the meter signal (P1859+P1018) is present.
 * AC-5: AIMD law — multiplicative decrease on sigterm/failure, additive
 *        increase on completion, bounded [floor, ceiling].
 *
 * Pure-logic / no DB / no clock — runs in the default suite.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	aimdNext,
	computeEffectiveCap,
	DEFAULT_TARGET_QUOTA_PCT,
	isMeterAvailable,
	nextCapacity,
	resolveTargetQuotaPct,
	type AimdConfig,
	type MeterSignal,
} from "./capacity-controller.ts";

const AIMD: Omit<AimdConfig, "ceiling"> = {
	floor: 0,
	decreaseFactor: 0.5,
	increaseStep: 1,
};

function signal(overrides: Partial<MeterSignal> = {}): MeterSignal {
	return {
		remainingQuota: 1000,
		cooldownUntil: null,
		authDownUntil: null,
		failureRate: 0,
		...overrides,
	};
}

describe("isMeterAvailable (P1699 AC-3 gate)", () => {
	test("null signal / null quota / negative quota → unavailable", () => {
		assert.equal(isMeterAvailable(null), false);
		assert.equal(isMeterAvailable(signal({ remainingQuota: null })), false);
		assert.equal(isMeterAvailable(signal({ remainingQuota: -1 })), false);
	});
	test("finite non-negative quota → available", () => {
		assert.equal(isMeterAvailable(signal({ remainingQuota: 0 })), true);
		assert.equal(isMeterAvailable(signal({ remainingQuota: 500 })), true);
	});
});

describe("computeEffectiveCap (P1699 AC-1 formula)", () => {
	test("cap is min(max_in_flight, floor(remaining * pct))", () => {
		// remaining 100 * 0.98 = 98 → min(10, 98) = 10 (max_in_flight binds)
		assert.equal(computeEffectiveCap(10, 100, 0.98), 10);
		// remaining 5 * 0.98 = 4.9 → floor 4 → min(10, 4) = 4 (quota binds)
		assert.equal(computeEffectiveCap(10, 5, 0.98), 4);
	});
	test("the target_quota_pct knob visibly changes the cap", () => {
		assert.equal(computeEffectiveCap(100, 100, 0.98), 98);
		assert.equal(computeEffectiveCap(100, 100, 0.5), 50);
		assert.equal(computeEffectiveCap(100, 100, 0.1), 10);
	});
	test("never negative", () => {
		assert.equal(computeEffectiveCap(10, 0, 0.98), 0);
	});
});

describe("resolveTargetQuotaPct (P1699 AC-1 knob precedence)", () => {
	test("agency override wins when valid", () => {
		assert.equal(resolveTargetQuotaPct(0.5, 0.8), 0.5);
	});
	test("falls through to global flag when no override", () => {
		assert.equal(resolveTargetQuotaPct(null, 0.8), 0.8);
		assert.equal(resolveTargetQuotaPct(undefined, 0.8), 0.8);
	});
	test("falls through to default 0.98 when neither set", () => {
		assert.equal(resolveTargetQuotaPct(null, null), DEFAULT_TARGET_QUOTA_PCT);
		assert.equal(resolveTargetQuotaPct(null, null), 0.98);
	});
	test("invalid override (0, >1, NaN, negative) is ignored, not clamped", () => {
		assert.equal(resolveTargetQuotaPct(0, 0.8), 0.8); // 0 not a meaningful throttle
		assert.equal(resolveTargetQuotaPct(1.5, 0.8), 0.8); // out of range
		assert.equal(resolveTargetQuotaPct(Number.NaN, 0.8), 0.8);
		assert.equal(resolveTargetQuotaPct(-0.2, 0.8), 0.8);
	});
	test("invalid flag falls through to default", () => {
		assert.equal(resolveTargetQuotaPct(null, 2), DEFAULT_TARGET_QUOTA_PCT);
	});
	test("pct=1 (full quota) is valid", () => {
		assert.equal(resolveTargetQuotaPct(1, 0.8), 1);
	});
});

describe("AC-1 verify: knob changes computed cap when meter is present", () => {
	// meter present: remaining_quota = 100 (non-null signal), max_in_flight huge
	// so the quota term binds and the knob is what moves the cap.
	const remaining = 100;
	const maxInFlight = 1000;
	test("resolved knob drives effective cap end-to-end", () => {
		const capDefault = computeEffectiveCap(
			maxInFlight,
			remaining,
			resolveTargetQuotaPct(null, null), // → 0.98
		);
		const capOverride = computeEffectiveCap(
			maxInFlight,
			remaining,
			resolveTargetQuotaPct(0.5, null), // agency override → 0.5
		);
		const capFlag = computeEffectiveCap(
			maxInFlight,
			remaining,
			resolveTargetQuotaPct(null, 0.1), // global flag → 0.1
		);
		assert.equal(capDefault, 98);
		assert.equal(capOverride, 50);
		assert.equal(capFlag, 10);
		// the knob visibly and monotonically changes the cap
		assert.ok(capFlag < capOverride && capOverride < capDefault);
	});
});

describe("aimdNext (P1699 AC-5 control law)", () => {
	const cfg: AimdConfig = { ceiling: 10, floor: 0, decreaseFactor: 0.5, increaseStep: 1 };
	test("completion → additive increase, capped at ceiling", () => {
		assert.equal(aimdNext(4, "completion", cfg), 5);
		assert.equal(aimdNext(10, "completion", cfg), 10); // ceiling holds
	});
	test("sigterm → multiplicative decrease, not below floor", () => {
		assert.equal(aimdNext(8, "sigterm", cfg), 4);
		assert.equal(aimdNext(1, "sigterm", cfg), 0); // floor(0.5)=0
		assert.equal(aimdNext(0, "sigterm", cfg), 0);
	});
	test("failure decreases like sigterm", () => {
		assert.equal(aimdNext(8, "failure", cfg), 4);
	});
	test("result is always within [floor, ceiling]", () => {
		const tight: AimdConfig = { ceiling: 5, floor: 2, decreaseFactor: 0.1, increaseStep: 100 };
		assert.equal(aimdNext(3, "completion", tight), 5); // clamped to ceiling
		assert.equal(aimdNext(3, "sigterm", tight), 2); // clamped to floor
	});
});

describe("nextCapacity (P1699 controller tick)", () => {
	test("AC-3: no meter → inert, cap 0", () => {
		const r = nextCapacity({
			current: 5,
			signal: signal({ remainingQuota: null }),
			event: "completion",
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.inert, true);
		assert.equal(r.cap, 0);
		assert.match(r.reason, /inert/);
	});

	test("auth down forces floor (active backpressure, not inert)", () => {
		const r = nextCapacity({
			current: 8,
			signal: signal({ authDownUntil: 5000 }),
			event: "completion",
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.inert, false);
		assert.equal(r.cap, 0); // floor
		assert.match(r.reason, /auth down/);
	});

	test("cooldown forces floor", () => {
		const r = nextCapacity({
			current: 8,
			signal: signal({ cooldownUntil: 5000 }),
			event: null,
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.cap, 0);
		assert.match(r.reason, /cooldown/);
	});

	test("healthy meter + completion → AIMD increase, clamped to effective cap", () => {
		// remaining 1000 * 0.98 = 980 → effective cap = min(10, 980) = 10
		const r = nextCapacity({
			current: 4,
			signal: signal({ remainingQuota: 1000 }),
			event: "completion",
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.inert, false);
		assert.equal(r.cap, 5);
	});

	test("low quota binds the cap below max_in_flight", () => {
		// remaining 3 * 0.98 = 2.94 → floor 2 → effective cap 2; current 8 clamped
		const r = nextCapacity({
			current: 8,
			signal: signal({ remainingQuota: 3 }),
			event: null,
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.cap, 2);
	});

	test("sigterm under healthy meter → multiplicative decrease", () => {
		const r = nextCapacity({
			current: 8,
			signal: signal({ remainingQuota: 1000 }),
			event: "sigterm",
			maxInFlight: 10,
			targetQuotaPct: 0.98,
			aimd: AIMD,
			nowMs: 1000,
		});
		assert.equal(r.cap, 4);
	});
});
