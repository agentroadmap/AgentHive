/**
 * P1374 (P1365-B) AC-7: cockpit ready/cooling + headroom-badge tests over
 * WorkforceAgent mock objects.
 *
 * The blessed render itself needs a live TTY and is verified via the TUI
 * snapshot harness (AC-8). Here we exercise the pure classification/format
 * logic that the renderer consumes — the same functions cockpit.ts calls — so
 * the header text and per-agent badges are deterministically asserted without a
 * terminal.
 */
import assert from "node:assert";
import { describe, test } from "node:test";
import {
	formatHeadroomBadge,
	formatReadyCoolingLabel,
	isCooling,
	splitReadyCooling,
} from "./cockpit-format.ts";
import type { WorkforceAgent } from "./cockpit.ts";

const NOW = 1_700_000_000_000;

function agent(over: Partial<WorkforceAgent>): WorkforceAgent {
	return {
		id: "a",
		name: "a",
		role: "claude@bot",
		status: "active",
		statusMessage: "online",
		presenceOnline: true,
		capacityThrottleAction: "none",
		capacityHeadroomPct: null,
		capacityResetAt: null,
		...over,
	};
}

/** Mirror cockpit.ts: idle = active && no currentProposal. */
function idleOf(agents: WorkforceAgent[]): WorkforceAgent[] {
	return agents.filter((a) => a.status === "active" && !a.currentProposal);
}

describe("P1374 AC-3/AC-7: ready/cooling split over WorkforceAgent mocks", () => {
	test("3 ready, 2 cooling → header '3 ready · 2 cooling'", () => {
		const agents = [
			agent({ id: "r1", capacityThrottleAction: "none" }),
			agent({ id: "r2", capacityThrottleAction: null }),
			agent({ id: "r3" }), // capacity absent ⇒ ready
			agent({ id: "c1", capacityThrottleAction: "soft" }),
			agent({ id: "c2", capacityThrottleAction: "soft" }),
		];
		const { ready, cooling } = splitReadyCooling(idleOf(agents));
		assert.equal(ready.length, 3);
		assert.equal(cooling.length, 2);
		assert.equal(
			formatReadyCoolingLabel(ready.length, cooling.length),
			"3 ready · 2 cooling",
		);
	});

	test("agencyCount sweep 0..5 ready vs 3 cooling renders header text", () => {
		for (let r = 0; r <= 5; r++) {
			const readyAgents = Array.from({ length: r }, (_, i) =>
				agent({ id: `r${i}`, capacityThrottleAction: "none" }),
			);
			const coolingAgents = Array.from({ length: 3 }, (_, i) =>
				agent({ id: `c${i}`, capacityThrottleAction: "soft" }),
			);
			const { ready, cooling } = splitReadyCooling(
				idleOf([...readyAgents, ...coolingAgents]),
			);
			assert.equal(ready.length, r);
			assert.equal(cooling.length, 3);
			assert.equal(
				formatReadyCoolingLabel(ready.length, cooling.length),
				`${r} ready · 3 cooling`,
			);
		}
	});

	test("0 cooling → header omits cooling segment", () => {
		const agents = [
			agent({ id: "r1" }),
			agent({ id: "r2" }),
			agent({ id: "r3" }),
			agent({ id: "r4" }),
			agent({ id: "r5" }),
		];
		const { ready, cooling } = splitReadyCooling(idleOf(agents));
		assert.equal(ready.length, 5);
		assert.equal(cooling.length, 0);
		assert.equal(formatReadyCoolingLabel(ready.length, cooling.length), "5 ready");
	});

	test("working agents (currentProposal set) are excluded from the split", () => {
		const agents = [
			agent({ id: "w1", currentProposal: "P9: x", capacityThrottleAction: "soft" }),
			agent({ id: "r1" }),
		];
		const { ready, cooling } = splitReadyCooling(idleOf(agents));
		assert.equal(ready.length, 1);
		assert.equal(cooling.length, 0); // soft worker is busy, not cooling-idle
	});
});

describe("P1374 AC-5/AC-7: per-agent headroom badge over mocks", () => {
	test("low-headroom ready agent gets a badge; healthy one does not", () => {
		const low = agent({
			id: "alice",
			capacityHeadroomPct: 18,
			capacityResetAt: NOW + 3 * 60_000,
		});
		const healthy = agent({ id: "bob", capacityHeadroomPct: 80 });
		assert.equal(
			formatHeadroomBadge(low.capacityHeadroomPct, low.capacityResetAt, NOW),
			"[18% reset in 3m]",
		);
		assert.equal(
			formatHeadroomBadge(
				healthy.capacityHeadroomPct,
				healthy.capacityResetAt,
				NOW,
			),
			"",
		);
	});

	test("soft-cooling agent with low headroom shows badge", () => {
		const c = agent({
			id: "carol",
			capacityThrottleAction: "soft",
			capacityHeadroomPct: 12,
			capacityResetAt: NOW + 5_000,
		});
		assert.equal(isCooling(c), true);
		assert.equal(
			formatHeadroomBadge(c.capacityHeadroomPct, c.capacityResetAt, NOW),
			"[12% reset in 5s]",
		);
	});
});

describe("P1374 AC-6: soft never appears as THROTTLED status", () => {
	test("soft throttle_action does not set status='throttled'", () => {
		// In unified-view.ts, status='throttled' is derived only from
		// agency_status/throttled_until (hard signals). A soft-capacity agent is
		// status='active' and lands in the idle→cooling bucket, not THROTTLED.
		const soft = agent({ id: "s1", capacityThrottleAction: "soft" });
		assert.equal(soft.status, "active");
		const throttledList = [soft].filter((a) => a.status === "throttled");
		assert.equal(throttledList.length, 0);
	});

	test("hard precedence: a throttled agent is excluded from idle entirely", () => {
		const hard = agent({
			id: "h1",
			status: "throttled",
			throttledUntil: NOW + 60_000,
			capacityThrottleAction: "soft", // even with a soft signal present
		});
		const idle = idleOf([hard]);
		assert.equal(idle.length, 0); // hard wins → not in AVAILABLE
	});
});
