/**
 * P1365-AC5: Capacity tracker tests
 * Tests throttle curve, reset detection, EWMA, threshold transitions
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { CapacityTracker } from "../../../src/infra/llm/capacity-tracker.ts";
import type { CapacitySignal } from "../../../src/infra/llm/rate-limit-parser.ts";

describe("CapacityTracker", () => {
	let tracker: CapacityTracker;
	const now = new Date("2026-05-22T10:00:00Z");

	beforeEach(() => {
		tracker = new CapacityTracker();
	});

	describe("happy path", () => {
		it("should record a signal and compute throttle", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 95,
				requests_limit: 100,
				tokens_remaining: 950000,
				tokens_limit: 1000000,
				reset_at: new Date("2026-05-22T11:00:00Z"),
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");

			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");
			assert.equal(throttle.action, "none");
			assert.equal(throttle.p_skip, 0);
			assert.equal(throttle.headroom_pct, 95);
		});
	});

	describe("reset detection", () => {
		it("should detect reset when tokens_remaining increases", () => {
			const signal1: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 90,
				requests_limit: 100,
				tokens_remaining: 900000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			const signal2: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 95,
				requests_limit: 100,
				tokens_remaining: 950000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: new Date(now.getTime() + 1000),
			};

			tracker.recordSignal(signal1, "agency-alpha");
			tracker.recordSignal(signal2, "agency-alpha");

			const entry = tracker.getState().get("anthropic:claude-opus-4:agency-alpha");
			assert.equal(entry!.samples.length, 1);
			assert.equal(entry!.samples[0].tokens_remaining, 950000);
		});
	});

	describe("EWMA burn rate", () => {
		it("should compute burn rate from token deltas", () => {
			const signal1: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 100,
				requests_limit: 100,
				tokens_remaining: 1000000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			const signal2: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 100,
				requests_limit: 100,
				tokens_remaining: 900000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: new Date(now.getTime() + 10000),
			};

			tracker.recordSignal(signal1, "agency-alpha");
			tracker.recordSignal(signal2, "agency-alpha");

			const entry = tracker.getState().get("anthropic:claude-opus-4:agency-alpha");
			assert.equal(entry!.burn_rate_per_sec, 10000);
		});

		it("should apply EWMA smoothing over 5+ samples", () => {
			const agencyId = "agency-beta";
			let timestamp = now.getTime();

			for (let i = 0; i < 5; i++) {
				const signal: CapacitySignal = {
					provider: "openai",
					model: "gpt-4",
					requests_remaining: 100,
					requests_limit: 100,
					tokens_remaining: 1000000 - (i + 1) * 100000,
					tokens_limit: 1000000,
					reset_at: null,
					sampled_at: new Date(timestamp),
				};
				tracker.recordSignal(signal, agencyId);
				timestamp += 10000;
			}

			const entry = tracker.getState().get("openai:gpt-4:agency-beta");
			// EWMA should be within 1000 of true 10000/s
			assert.ok(
				Math.abs(entry!.burn_rate_per_sec! - 10000) < 1000,
				`burn_rate_per_sec ${entry!.burn_rate_per_sec} not within 1000 of 10000`,
			);
		});
	});

	describe("throttle curve: threshold transitions", () => {
		it("should return action=none when headroom >= 50%", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 50,
				requests_limit: 100,
				tokens_remaining: 500000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.action, "none");
			assert.equal(throttle.p_skip, 0);
			assert.equal(throttle.headroom_pct, 50);
		});

		it("should return action=soft with linear p_skip when 25% <= headroom < 50%", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 37.5,
				requests_limit: 100,
				tokens_remaining: null,
				tokens_limit: null,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.action, "soft");
			assert.equal(throttle.headroom_pct, 37.5);
			assert.ok(Math.abs(throttle.p_skip - 0.125) < 0.001);
		});

		it("should return action=soft with higher p_skip when 10% <= headroom < 25%", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 17.5,
				requests_limit: 100,
				tokens_remaining: null,
				tokens_limit: null,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.action, "soft");
			assert.equal(throttle.headroom_pct, 17.5);
			assert.ok(Math.abs(throttle.p_skip - 0.475) < 0.001);
		});

		it("should return action=hard when headroom < 10%", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 5,
				requests_limit: 100,
				tokens_remaining: null,
				tokens_limit: null,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.action, "hard");
			assert.equal(throttle.p_skip, 1);
		});
	});

	describe("headroom computation", () => {
		it("should use min of requests and tokens headroom", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 80,
				requests_limit: 100,
				tokens_remaining: 300000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.headroom_pct, 30);
		});

		it("should skip null headroom components", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 25,
				requests_limit: 100,
				tokens_remaining: null,
				tokens_limit: null,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.headroom_pct, 25);
		});

		it("should return null headroom and unknown action when no limits available", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 50,
				requests_limit: null,
				tokens_remaining: 500000,
				tokens_limit: null,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-alpha");

			assert.equal(throttle.headroom_pct, null);
			assert.equal(throttle.action, "unknown");
			assert.equal(throttle.p_skip, 0);
		});
	});

	describe("no signal", () => {
		it("should return action=none with p_skip=0 when no signal recorded", () => {
			const throttle = tracker.computeThrottle("anthropic", "claude-opus-4", "agency-unknown");

			assert.equal(throttle.action, "none");
			assert.equal(throttle.p_skip, 0);
			assert.equal(throttle.headroom_pct, null);
		});
	});

	describe("clear and clearAll", () => {
		it("should clear a specific entry", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 50,
				requests_limit: 100,
				tokens_remaining: 500000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			assert.equal(tracker.getState().size, 1);

			tracker.clear("anthropic", "claude-opus-4", "agency-alpha");
			assert.equal(tracker.getState().size, 0);
		});

		it("should clear all entries", () => {
			const signal: CapacitySignal = {
				provider: "anthropic",
				model: "claude-opus-4",
				requests_remaining: 50,
				requests_limit: 100,
				tokens_remaining: 500000,
				tokens_limit: 1000000,
				reset_at: null,
				sampled_at: now,
			};

			tracker.recordSignal(signal, "agency-alpha");
			tracker.recordSignal(signal, "agency-beta");
			assert.equal(tracker.getState().size, 2);

			tracker.clearAll();
			assert.equal(tracker.getState().size, 0);
		});
	});
});
