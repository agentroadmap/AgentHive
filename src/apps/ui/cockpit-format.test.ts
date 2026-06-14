import assert from "node:assert";
import { describe, test } from "node:test";
import {
	buildWorkforceSubheaderParts,
	type CapacityView,
	type CockpitCounts,
	formatCockpitHeaderCounts,
	formatDriftMarker,
	formatHeadroomBadge,
	formatReadyCoolingLabel,
	formatRelativeTime,
	HEADROOM_BADGE_THRESHOLD,
	isCooling,
	splitReadyCooling,
} from "./cockpit-format.ts";

describe("P1374 AC-3: ready/cooling split", () => {
	test("isCooling is true only for soft throttle_action", () => {
		assert.equal(isCooling({ capacityThrottleAction: "soft" }), true);
		assert.equal(isCooling({ capacityThrottleAction: "none" }), false);
		assert.equal(isCooling({ capacityThrottleAction: "hard" }), false);
		assert.equal(isCooling({ capacityThrottleAction: null }), false);
		assert.equal(isCooling({}), false); // no capacity row ⇒ ready
	});

	test("splitReadyCooling buckets idle agents by throttle_action", () => {
		const idle: CapacityView[] = [
			{ capacityThrottleAction: "none" },
			{ capacityThrottleAction: "soft" },
			{ capacityThrottleAction: "soft" },
			{}, // absent ⇒ ready
			{ capacityThrottleAction: null }, // null ⇒ ready
		];
		const { ready, cooling } = splitReadyCooling(idle);
		assert.equal(ready.length, 3);
		assert.equal(cooling.length, 2);
	});

	test("AC-3 fixture: 3 ready, 2 cooling renders '3 ready · 2 cooling'", () => {
		assert.equal(formatReadyCoolingLabel(3, 2), "3 ready · 2 cooling");
	});

	test("cooling = 0 renders just 'N ready' (no middot)", () => {
		assert.equal(formatReadyCoolingLabel(5, 0), "5 ready");
		assert.equal(formatReadyCoolingLabel(0, 0), "0 ready");
	});

	test("AC-7 sweep: 0..5 ready vs 0/3 cooling renders correctly", () => {
		for (let r = 0; r <= 5; r++) {
			assert.equal(formatReadyCoolingLabel(r, 0), `${r} ready`);
			assert.equal(formatReadyCoolingLabel(r, 3), `${r} ready · 3 cooling`);
		}
	});
});

describe("P1377 AC-2/AC-7: cockpit header counts", () => {
	const counts: CockpitCounts = {
		total_agents: 269,
		total_providers: 3,
		online_count: 2,
		registered_agencies: 4,
		drift_count: 265,
	};

	test("renders exact 'agents · providers · online · registered' order", () => {
		assert.equal(
			formatCockpitHeaderCounts(counts),
			"269 agents · 3 providers · 2 online · 4 registered",
		);
	});

	test("the word 'agencies' must NOT appear in the header", () => {
		const out = formatCockpitHeaderCounts(counts);
		assert.ok(
			!/agencies/i.test(out),
			`header must not contain 'agencies': ${out}`,
		);
	});

	test("uses middle-dot ' · ' dividers (exactly 3)", () => {
		const out = formatCockpitHeaderCounts(counts);
		assert.equal(out.split(" · ").length, 4);
	});
});

describe("P1377 AC-3/AC-8: workforce subheader parts", () => {
	const counts: CockpitCounts = {
		total_agents: 100,
		total_providers: 3,
		online_count: 5,
		registered_agencies: 20,
		drift_count: 80,
	};

	test("returns EXACTLY 4 elements in agents,providers,online,registered order", () => {
		const parts = buildWorkforceSubheaderParts(counts);
		assert.equal(parts.length, 4);
		assert.deepEqual(parts, [
			"100 agents",
			"3 providers",
			"5 online",
			"20 registered",
		]);
	});

	test("joined with ' · ' yields the canonical subheader line", () => {
		assert.equal(
			buildWorkforceSubheaderParts(counts).join(" · "),
			"100 agents · 3 providers · 5 online · 20 registered",
		);
	});

	test("no element contains the word 'agencies'", () => {
		for (const p of buildWorkforceSubheaderParts(counts)) {
			assert.ok(!/agencies/i.test(p), `part must not say 'agencies': ${p}`);
		}
	});
});

describe("P1377 AC-3/AC-9: drift marker", () => {
	test("drift agent renders ' [DRIFT]', registered renders ''", () => {
		assert.equal(formatDriftMarker(true), " [DRIFT]");
		assert.equal(formatDriftMarker(false), "");
		assert.equal(formatDriftMarker(undefined), "");
	});

	test("5-agent fixture: 3 registered + 2 drift ⇒ [DRIFT] exactly twice", () => {
		// Simulate the render path's per-agent marker emission.
		const agents = [
			{ id: "alice", is_drift: false },
			{ id: "bob", is_drift: false },
			{ id: "carol", is_drift: false },
			{ id: "dave", is_drift: true },
			{ id: "erin", is_drift: true },
		];
		const rendered = agents.map(
			(a) => `${a.id}${formatDriftMarker(a.is_drift)}`,
		);
		const blob = rendered.join("\n");
		const markerCount = (blob.match(/\[DRIFT\]/g) ?? []).length;
		assert.equal(markerCount, 2, "exactly two [DRIFT] markers");
		// the 3 registered agents carry no marker
		assert.ok(!/alice \[DRIFT\]/.test(blob));
		assert.ok(!/bob \[DRIFT\]/.test(blob));
		assert.ok(!/carol \[DRIFT\]/.test(blob));
		assert.ok(/dave \[DRIFT\]/.test(blob));
		assert.ok(/erin \[DRIFT\]/.test(blob));
	});
});

describe("P1374: formatRelativeTime", () => {
	test("negative duration ⇒ now", () => {
		assert.equal(formatRelativeTime(-1), "now");
	});
	test("seconds bucket", () => {
		assert.equal(formatRelativeTime(5_000), "in 5s");
		assert.equal(formatRelativeTime(59_000), "in 59s");
	});
	test("minutes bucket", () => {
		assert.equal(formatRelativeTime(60_000), "in 1m");
		assert.equal(formatRelativeTime(3 * 60_000), "in 3m");
	});
	test("hours bucket", () => {
		assert.equal(formatRelativeTime(60 * 60_000), "in 1h");
		assert.equal(formatRelativeTime(2 * 60 * 60_000), "in 2h");
	});
});

describe("P1374 AC-5: headroom badge '[X% reset in Tm]'", () => {
	const NOW = 1_000_000_000_000;

	test("24% with 3min reset shows '[24% reset in 3m]'", () => {
		const badge = formatHeadroomBadge(24, NOW + 3 * 60_000, NOW);
		assert.equal(badge, "[24% reset in 3m]");
	});

	test("12% with 5sec reset shows '[12% reset in 5s]'", () => {
		const badge = formatHeadroomBadge(12, NOW + 5_000, NOW);
		assert.equal(badge, "[12% reset in 5s]");
	});

	test("missing headroom ⇒ no badge", () => {
		assert.equal(formatHeadroomBadge(null, NOW + 5_000, NOW), "");
		assert.equal(formatHeadroomBadge(undefined, NOW + 5_000, NOW), "");
	});

	test("headroom >= threshold ⇒ no badge (boundary at 25)", () => {
		assert.equal(formatHeadroomBadge(25, NOW + 5_000, NOW), "");
		assert.equal(formatHeadroomBadge(80, NOW + 5_000, NOW), "");
		// just below threshold still badges
		assert.equal(
			formatHeadroomBadge(24.9, NOW + 60_000, NOW),
			"[25% reset in 1m]", // rounds to 25 for display but still < threshold
		);
	});

	test("rounds headroom_pct for display", () => {
		assert.equal(formatHeadroomBadge(18.4, NOW + 60_000, NOW), "[18% reset in 1m]");
		assert.equal(formatHeadroomBadge(18.6, NOW + 60_000, NOW), "[19% reset in 1m]");
	});

	test("low headroom with no reset_at ⇒ 'reset unknown'", () => {
		assert.equal(formatHeadroomBadge(10, null, NOW), "[10% reset unknown]");
		assert.equal(formatHeadroomBadge(10, undefined, NOW), "[10% reset unknown]");
	});

	test("already-elapsed reset ⇒ 'reset now'", () => {
		assert.equal(formatHeadroomBadge(10, NOW - 5_000, NOW), "[10% reset now]");
	});

	test("threshold constant is 25", () => {
		assert.equal(HEADROOM_BADGE_THRESHOLD, 25);
	});
});
