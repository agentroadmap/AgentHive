/**
 * P3000 (P2995-AC6) — Tests for the fair-share DEBT tracker (METER-INDEPENDENT).
 *
 * Covers:
 *   AC-7  pure cycle accounting (increment / reset) + starvation threshold logic
 *   AC-8  observability metric emission via injected spy
 *   AC-10 (cost-INDEPENDENT case): starvation-recovery scenario — an agent that
 *         is repeatedly rejected eventually earns a one-time reserved slot.
 *
 * No live DB: pure functions are tested directly; the thin query functions are
 * exercised against an in-memory fake QueryFn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_STARVATION_THRESHOLD,
	RESERVED_SLOT_TIER,
	type DebtState,
	type QueryFn,
	evaluateStarvation,
	evaluateStarvationWithMetrics,
	incrementCycles,
	recordRejection,
	recordDispatch,
	resetDebt,
} from "./fair-share-debt.ts";
import type { QuotaMetricEvent } from "../observability/quota-metrics.ts";

function freshState(overrides: Partial<DebtState> = {}): DebtState {
	return {
		agentIdentity: "agent.test",
		cyclesSinceDispatch: 0,
		lastClaimedAt: null,
		reservedOverrideActive: false,
		...overrides,
	};
}

// ── AC-7: pure cycle accounting ────────────────────────────────────────────

test("AC-7 incrementCycles: adds exactly one cycle, immutably", () => {
	const s0 = freshState({ cyclesSinceDispatch: 4 });
	const s1 = incrementCycles(s0);
	assert.equal(s1.cyclesSinceDispatch, 5);
	assert.equal(s0.cyclesSinceDispatch, 4, "input not mutated");
});

test("AC-7 resetDebt: zeroes cycles, clears latch, stamps last_claimed_at", () => {
	const when = new Date("2026-06-14T00:00:00Z");
	const s = resetDebt(
		freshState({ cyclesSinceDispatch: 12, reservedOverrideActive: true }),
		when,
	);
	assert.equal(s.cyclesSinceDispatch, 0);
	assert.equal(s.reservedOverrideActive, false);
	assert.equal(s.lastClaimedAt, when);
});

// ── AC-7: starvation threshold ─────────────────────────────────────────────

test("AC-7 evaluateStarvation: below threshold keeps normal tier, not starved", () => {
	const d = evaluateStarvation(freshState({ cyclesSinceDispatch: 10 }), 3);
	assert.equal(d.starved, false);
	assert.equal(d.grantReservedSlot, false);
	assert.equal(d.effectivePriorityTier, 3, "normal tier preserved");
});

test("AC-7 evaluateStarvation: strictly ABOVE threshold (11) is starved and grants reserved slot once", () => {
	const d = evaluateStarvation(freshState({ cyclesSinceDispatch: 11 }), 3);
	assert.equal(d.starved, true);
	assert.equal(d.grantReservedSlot, true);
	assert.equal(d.effectivePriorityTier, RESERVED_SLOT_TIER);
	assert.equal(RESERVED_SLOT_TIER, -1);
});

test("AC-7 evaluateStarvation: one-shot latch — no re-grant when override already active", () => {
	const d = evaluateStarvation(
		freshState({ cyclesSinceDispatch: 25, reservedOverrideActive: true }),
		2,
	);
	assert.equal(d.starved, true);
	assert.equal(d.grantReservedSlot, false, "latch suppresses re-grant");
	assert.equal(d.effectivePriorityTier, RESERVED_SLOT_TIER, "still gets reserved slot");
});

test("AC-7 default starvation threshold is 10", () => {
	assert.equal(DEFAULT_STARVATION_THRESHOLD, 10);
});

// ── AC-8: observability emission via spy ───────────────────────────────────

test("AC-8 evaluateStarvationWithMetrics: emits recovery + headroom metrics on grant", () => {
	const emitted: QuotaMetricEvent[] = [];
	const d = evaluateStarvationWithMetrics(
		freshState({ cyclesSinceDispatch: 11 }),
		3,
		{ emit: (e) => emitted.push(e) },
	);
	assert.equal(d.grantReservedSlot, true);
	const names = emitted.map((e) => e.metricName).sort();
	assert.deepEqual(names, [
		"quota:reserved_headroom_granted",
		"quota:starvation_recovery",
	]);
	for (const e of emitted) {
		assert.equal(e.agentIdentity, "agent.test");
	}
});

test("AC-8 evaluateStarvationWithMetrics: emits NOTHING when not starved", () => {
	const emitted: QuotaMetricEvent[] = [];
	evaluateStarvationWithMetrics(freshState({ cyclesSinceDispatch: 3 }), 3, {
		emit: (e) => emitted.push(e),
	});
	assert.equal(emitted.length, 0);
});

test("AC-8 evaluateStarvationWithMetrics: latched override emits nothing (one-shot)", () => {
	const emitted: QuotaMetricEvent[] = [];
	evaluateStarvationWithMetrics(
		freshState({ cyclesSinceDispatch: 40, reservedOverrideActive: true }),
		1,
		{ emit: (e) => emitted.push(e) },
	);
	assert.equal(emitted.length, 0, "no duplicate recovery metric while latched");
});

// ── thin query functions against an in-memory fake ─────────────────────────

test("recordRejection: issues an upsert and returns the new cycle count", async () => {
	const calls: { sql: string; params: any[] }[] = [];
	const fake: QueryFn = async (sql, params) => {
		calls.push({ sql, params: params ?? [] });
		return { rows: [{ cycles_since_dispatch: 7 }] } as any;
	};
	const n = await recordRejection("agent.x", fake);
	assert.equal(n, 7);
	assert.equal(calls.length, 1);
	assert.match(calls[0].sql, /INSERT INTO roadmap_workforce\.fair_share_debt/);
	assert.match(calls[0].sql, /ON CONFLICT \(agent_identity\) DO UPDATE/);
	assert.deepEqual(calls[0].params, ["agent.x"]);
});

test("recordDispatch: resets cycles + clears latch via upsert", async () => {
	const calls: { sql: string; params: any[] }[] = [];
	const fake: QueryFn = async (sql, params) => {
		calls.push({ sql, params: params ?? [] });
		return { rows: [] } as any;
	};
	await recordDispatch("agent.y", fake);
	assert.equal(calls.length, 1);
	assert.match(calls[0].sql, /cycles_since_dispatch = 0/);
	assert.match(calls[0].sql, /reserved_override_active = false/);
	assert.deepEqual(calls[0].params, ["agent.y"]);
});

// ── AC-10 (cost-INDEPENDENT): end-to-end starvation-recovery simulation ─────

test("AC-10 starvation-recovery: repeated rejections eventually trigger a one-time reserved slot, then dispatch clears it", () => {
	// Simulate the cycle accounting purely (no DB), driving evaluateStarvation
	// the way the future flag-gated shadow caller would.
	let state = freshState({ agentIdentity: "agent.starved" });
	const grants: number[] = []; // cycle counts at which a reserved slot is granted
	const NORMAL_TIER = 4;

	for (let cycle = 1; cycle <= 15; cycle++) {
		state = incrementCycles(state);
		const d = evaluateStarvation(state, NORMAL_TIER);
		if (d.grantReservedSlot) {
			grants.push(state.cyclesSinceDispatch);
			// caller latches the one-shot override
			state = { ...state, reservedOverrideActive: true };
		}
	}

	// Threshold is 10 → first grant at cycle 11, and EXACTLY ONE grant (one-shot).
	assert.deepEqual(grants, [11], "single one-time reserved-slot grant at cycle 11");

	// A successful dispatch resets everything: back to normal tier, latch cleared.
	state = resetDebt(state, new Date());
	const after = evaluateStarvation(state, NORMAL_TIER);
	assert.equal(after.starved, false);
	assert.equal(after.effectivePriorityTier, NORMAL_TIER);
	assert.equal(state.reservedOverrideActive, false);
});
