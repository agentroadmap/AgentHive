import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	OUTCOME_SHARES,
	computePosterior,
	posteriorMean,
	decayWeight,
	effectiveSampleCount,
	confidenceFor,
	resolveColdStart,
	type ReliabilityObservation,
} from "../src/core/scoring/reliability-math.ts";
import {
	getReliability,
	fetchReliabilityCell,
	type QueryFn,
} from "../src/core/scoring/reliability-ledger.ts";

/**
 * P3311 (Child B): reliability ledger scoring math + read API.
 *
 * Pure-logic tests against synthetic data — no live DB. The read-API tests use
 * an in-memory fake that mimics fn_p3311_reliability_lookup()'s row shape.
 */

// ---------------------------------------------------------------------------
// AC-5: Beta-Bernoulli posterior
// ---------------------------------------------------------------------------
describe("P3311 AC-5: Beta-Bernoulli posterior", () => {
	it("uniform prior with no data = 0.5", () => {
		const p = computePosterior([]);
		assert.equal(p.alpha, 1);
		assert.equal(p.beta, 1);
		assert.equal(posteriorMean(p), 0.5);
	});

	it("all successes pushes mean toward 1", () => {
		const obs: ReliabilityObservation[] = Array.from({ length: 20 }, () => ({
			outcome: "success" as const,
			ageDays: 0,
		}));
		const mean = posteriorMean(computePosterior(obs, 1.0)); // no decay
		assert.ok(mean > 0.9, `expected >0.9, got ${mean}`);
	});

	it("all hard failures pushes mean toward 0", () => {
		const obs: ReliabilityObservation[] = Array.from({ length: 20 }, () => ({
			outcome: "hard_failure" as const,
			ageDays: 0,
		}));
		const mean = posteriorMean(computePosterior(obs, 1.0));
		assert.ok(mean < 0.1, `expected <0.1, got ${mean}`);
	});
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------
describe("P3311: time decay", () => {
	it("fresh observation has weight 1", () => {
		assert.equal(decayWeight(0, 0.97), 1);
	});
	it("older observations weigh less", () => {
		assert.ok(decayWeight(30, 0.97) < decayWeight(1, 0.97));
	});
	it("negative age clamps to weight 1", () => {
		assert.equal(decayWeight(-5, 0.97), 1);
	});
	it("rejects invalid lambda", () => {
		assert.throws(() => decayWeight(1, 0));
		assert.throws(() => decayWeight(1, 1.5));
	});
	it("effective sample count is the sum of decay weights", () => {
		const obs: ReliabilityObservation[] = [
			{ outcome: "success", ageDays: 0 },
			{ outcome: "success", ageDays: 0 },
		];
		assert.equal(effectiveSampleCount(obs, 1.0), 2);
	});
});

// ---------------------------------------------------------------------------
// AC-3: distinct failure weighting ordering
// ---------------------------------------------------------------------------
describe("P3311 AC-3: distinct failure weighting", () => {
	it("penalty severity order: protocol > hard > rework > success(=0)", () => {
		const betaShare = (o: keyof typeof OUTCOME_SHARES) => OUTCOME_SHARES[o].beta;
		assert.ok(betaShare("protocol_failure") > betaShare("hard_failure"));
		assert.ok(betaShare("hard_failure") > betaShare("rework"));
		assert.ok(betaShare("rework") > betaShare("success"));
		assert.equal(betaShare("success"), 0);
	});

	it("protocol failures degrade the score more than the same count of hard failures", () => {
		const n = 15;
		const protocolObs: ReliabilityObservation[] = Array.from({ length: n }, () => ({
			outcome: "protocol_failure" as const,
			ageDays: 0,
		}));
		const hardObs: ReliabilityObservation[] = Array.from({ length: n }, () => ({
			outcome: "hard_failure" as const,
			ageDays: 0,
		}));
		const protocolScore = posteriorMean(computePosterior(protocolObs, 1.0));
		const hardScore = posteriorMean(computePosterior(hardObs, 1.0));
		assert.ok(
			protocolScore < hardScore,
			`protocol(${protocolScore}) should be < hard(${hardScore})`,
		);
	});

	it("provider_mismatch is counted as a tainted (partial) success", () => {
		assert.ok(OUTCOME_SHARES.mismatch.alpha > 0);
		assert.ok(OUTCOME_SHARES.mismatch.beta > 0);
		assert.ok(OUTCOME_SHARES.mismatch.beta > OUTCOME_SHARES.mismatch.alpha);
	});
});

// ---------------------------------------------------------------------------
// AC-2: confidence + cold-start hierarchical fallback
// ---------------------------------------------------------------------------
describe("P3311 AC-2: confidence + cold-start fallback", () => {
	it("confidence tiers track effective sample count", () => {
		assert.equal(confidenceFor(2), "low");
		assert.equal(confidenceFor(10), "medium");
		assert.equal(confidenceFor(50), "high");
	});

	it("exact cell with enough samples wins", () => {
		const r = resolveColdStart(
			{ exact: { score: 0.8, effectiveSampleCount: 30, sampleCount: 30 } },
			0.3,
		);
		assert.equal(r.level, "exact");
		assert.equal(r.score, 0.8);
		assert.equal(r.confidence, "high");
	});

	it("falls through to family then global when exact is too cold", () => {
		const r = resolveColdStart(
			{
				exact: { score: 0.9, effectiveSampleCount: 1, sampleCount: 1 },
				family: { score: 0.7, effectiveSampleCount: 25, sampleCount: 25 },
				global: { score: 0.5, effectiveSampleCount: 200, sampleCount: 200 },
			},
			0.3,
		);
		assert.equal(r.level, "family");
		assert.equal(r.score, 0.7);
	});

	it("uses tier prior when no cell has any data", () => {
		const r = resolveColdStart({}, 0.35);
		assert.equal(r.level, "prior");
		assert.equal(r.score, 0.35);
		assert.equal(r.confidence, "low");
	});

	it("blends sparse data toward prior", () => {
		const r = resolveColdStart(
			{ exact: { score: 1.0, effectiveSampleCount: 2, sampleCount: 2 } },
			0.4,
			5,
		);
		// wData = 2/5 = 0.4 → 0.4*1.0 + 0.6*0.4 = 0.64
		assert.equal(r.level, "prior");
		assert.ok(Math.abs(r.score - 0.64) < 1e-9, `got ${r.score}`);
	});
});

// ---------------------------------------------------------------------------
// AC-4: read API — repeated mcp_protocol tool failures degrade ONLY that class
// ---------------------------------------------------------------------------
describe("P3311 AC-4: read API per-class isolation", () => {
	/**
	 * Fake fn_p3311_reliability_lookup. Models a model that is reliable on
	 * 'develop' but has repeated tool/protocol failures on 'mcp_protocol'.
	 * Returns one 'exact' row for whichever task_class is requested.
	 */
	const fakeQuery: QueryFn = async (_text: string, params?: any[]) => {
		const taskClass = params?.[2] as string;
		const table: Record<string, { score: number; eff: number; n: number }> = {
			mcp_protocol: { score: 0.08, eff: 40, n: 50 }, // degraded — protocol failures
			develop: { score: 0.86, eff: 35, n: 40 }, // healthy
		};
		const cell = table[taskClass];
		if (!cell) return { rows: [] };
		return {
			rows: [
				{
					score: cell.score,
					effective_sample_count: cell.eff,
					sample_count: cell.n,
					resolved_task_class: taskClass,
					fallback_level: "exact",
				},
			],
		};
	};

	it("mcp_protocol score is degraded", async () => {
		const r = await getReliability(
			{ scopeType: "model", scopeKey: "flaky-model" },
			"mcp_protocol",
			{ query: fakeQuery },
		);
		assert.ok(r.score < 0.3, `expected degraded <0.3, got ${r.score}`);
		assert.equal(r.resolved_level, "exact");
		assert.equal(r.confidence, "high");
	});

	it("develop score for the SAME model is unaffected", async () => {
		const r = await getReliability(
			{ scopeType: "model", scopeKey: "flaky-model" },
			"develop",
			{ query: fakeQuery },
		);
		assert.ok(r.score > 0.8, `expected healthy >0.8, got ${r.score}`);
	});

	it("isolation: degraded class does not pull down the healthy class", async () => {
		const proto = await getReliability(
			{ scopeType: "model", scopeKey: "flaky-model" },
			"mcp_protocol",
			{ query: fakeQuery },
		);
		const dev = await getReliability(
			{ scopeType: "model", scopeKey: "flaky-model" },
			"develop",
			{ query: fakeQuery },
		);
		assert.ok(dev.score - proto.score > 0.5, "classes must be scored independently");
	});

	it("cold class with no rows falls back to tier prior", async () => {
		const r = await getReliability(
			{ scopeType: "model", scopeKey: "flaky-model", tierPrior: 0.3 },
			"gate_review",
			{ query: fakeQuery },
		);
		assert.equal(r.resolved_level, "prior");
		assert.equal(r.score, 0.3);
	});
});

// ---------------------------------------------------------------------------
// P3312 drop-in adapter contract
// ---------------------------------------------------------------------------
describe("P3311: fetchReliabilityCell P3312 drop-in", () => {
	const fakeQuery: QueryFn = async (_t, params) => {
		const taskClass = params?.[2] as string;
		if (taskClass !== "mcp_protocol") return { rows: [] };
		return {
			rows: [
				{
					score: 0.08,
					effective_sample_count: 40,
					sample_count: 50,
					resolved_task_class: "mcp_protocol",
					fallback_level: "exact",
				},
			],
		};
	};

	it("returns { sample_count, success_rate } shape", async () => {
		const cell = await fetchReliabilityCell(69, "mcp_protocol", "frontier", fakeQuery);
		assert.equal(typeof cell.sample_count, "number");
		assert.equal(typeof cell.success_rate, "number");
		assert.equal(cell.sample_count, 50);
		assert.ok(Math.abs(cell.success_rate - 0.08) < 1e-9);
	});

	it("cold route returns 0 samples (matcher applies its own prior)", async () => {
		const cell = await fetchReliabilityCell(999, "develop", "free", fakeQuery);
		assert.equal(cell.sample_count, 0);
	});
});
