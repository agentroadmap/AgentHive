import assert from "node:assert";
import { describe, it } from "node:test";
import {
	adjustDependenciesForInsertBetween,
	computeSequences,
} from "../../src/core/proposal/sequences.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

function t(id: string, deps: string[] = []): Proposal {
	return {
		id,
		title: id,
		status: "Potential",
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: deps,
		description: "Test",
	};
}

describe("adjustDependenciesForInsertBetween", () => {
	it("creates new sequence between K and K+1 with dependency updates", () => {
		// seq1: 1,2 ; seq2: 3(dep:1,2) ; seq3: 4(dep:3), 5(dep:3)
		const proposals = [
			t("proposal-1"),
			t("proposal-2"),
			t("proposal-3", ["proposal-1", "proposal-2"]),
			t("proposal-4", ["proposal-3"]),
			t("proposal-5", ["proposal-3"]),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 3);
		// Drop proposal-5 between seq1 (K=1) and seq2 (K+1)
		const updated = adjustDependenciesForInsertBetween(
			proposals,
			res.sequences,
			"proposal-5",
			1,
		);
		const next = computeSequences(updated);
		// Expect: seq1: 1,2 ; seq2: 5 ; seq3: 3 ; seq4: 4
		assert.strictEqual(next.sequences.length, 4);
		expect(next.sequences[0]?.proposals.map((x) => x.id)).toEqual([
			"proposal-1",
			"proposal-2",
		]);
		expect(next.sequences[1]?.proposals.map((x) => x.id)).toEqual([
			"proposal-5",
		]);
		expect(next.sequences[2]?.proposals.map((x) => x.id)).toEqual([
			"proposal-3",
		]);
		expect(next.sequences[3]?.proposals.map((x) => x.id)).toEqual([
			"proposal-4",
		]);
	});

	it("supports top insertion (K=0): moved becomes Sequence 1; next sequence proposals depend on moved", () => {
		// seq1: 1 ; seq2: 2(dep:1)
		const proposals = [
			t("proposal-1"),
			t("proposal-2", ["proposal-1"]),
			t("proposal-3"),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 2);
		const updated = adjustDependenciesForInsertBetween(
			proposals,
			res.sequences,
			"proposal-3",
			0,
		);
		const next = computeSequences(updated);
		// Expect: seq1: 3 ; seq2: 1 ; seq3: 2
		assert.strictEqual(next.sequences.length, 3);
		expect(next.sequences[0]?.proposals.map((x) => x.id)).toEqual([
			"proposal-3",
		]);
		expect(next.sequences[1]?.proposals.map((x) => x.id)).toEqual([
			"proposal-1",
		]);
		expect(next.sequences[2]?.proposals.map((x) => x.id)).toEqual([
			"proposal-2",
		]);
	});

	it("when there are no sequences, top insertion anchors moved via ordinal", () => {
		// All proposals unsequenced initially (no deps, no dependents)
		const proposals = [t("proposal-1"), t("proposal-2")];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 0);
		const updated = adjustDependenciesForInsertBetween(
			proposals,
			res.sequences,
			"proposal-2",
			0,
		);
		const byId = new Map(updated.map((x) => [x.id, x]));
		// moved has ordinal set
		expect(byId.get("proposal-2")?.ordinal).toBe(0);
		const next = computeSequences(updated);
		assert.strictEqual(next.sequences.length, 1);
		expect(next.sequences[0]?.proposals.map((x) => x.id)).toEqual([
			"proposal-2",
		]);
	});
});
