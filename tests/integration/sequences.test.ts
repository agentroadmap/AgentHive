import assert from "node:assert";
import { describe, it } from "node:test";
import { computeSequences } from "../../src/core/proposal/sequences.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

function proposal(id: string, deps: string[] = []): Proposal {
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

describe("computeSequences (with Unsequenced)", () => {
	function mustGet<T>(arr: T[], idx: number): T {
		const v = arr[idx];
		if (v === undefined) throw new Error(`expected element at index ${idx}`);
		return v;
	}
	it("puts isolated proposals into Unsequenced bucket", () => {
		const proposals = [
			proposal("proposal-1"),
			proposal("proposal-2"),
			proposal("proposal-3"),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 0);
		expect(res.unsequenced.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-3",
		]);
	});

	it("handles a simple chain A -> B -> C", () => {
		const proposals = [
			proposal("proposal-1"),
			proposal("proposal-2", ["proposal-1"]),
			proposal("proposal-3", ["proposal-2"]),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 3);
		expect(mustGet(res.sequences, 0).proposals.map((t) => t.id)).toEqual([
			"proposal-1",
		]);
		expect(mustGet(res.sequences, 1).proposals.map((t) => t.id)).toEqual([
			"proposal-2",
		]);
		expect(mustGet(res.sequences, 2).proposals.map((t) => t.id)).toEqual([
			"proposal-3",
		]);
	});

	it("groups parallel branches (A -> C, B -> C) into same sequence", () => {
		const proposals = [
			proposal("proposal-1"),
			proposal("proposal-2"),
			proposal("proposal-3", ["proposal-1", "proposal-2"]),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 2);
		// First layer contains 1 and 2 in id order
		expect(mustGet(res.sequences, 0).proposals.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
		]);
		// Second layer contains 3
		expect(mustGet(res.sequences, 1).proposals.map((t) => t.id)).toEqual([
			"proposal-3",
		]);
	});

	it("handles a more complex graph", () => {
		// 1,2 -> 4 ; 3 -> 5 -> 6
		const proposals = [
			proposal("proposal-1"),
			proposal("proposal-2"),
			proposal("proposal-3"),
			proposal("proposal-4", ["proposal-1", "proposal-2"]),
			proposal("proposal-5", ["proposal-3"]),
			proposal("proposal-6", ["proposal-5"]),
		];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 3);
		expect(mustGet(res.sequences, 0).proposals.map((t) => t.id)).toEqual([
			"proposal-1",
			"proposal-2",
			"proposal-3",
		]);
		// Second layer should include 4 and 5 (order by id)
		expect(mustGet(res.sequences, 1).proposals.map((t) => t.id)).toEqual([
			"proposal-4",
			"proposal-5",
		]);
		// Final layer 6
		expect(mustGet(res.sequences, 2).proposals.map((t) => t.id)).toEqual([
			"proposal-6",
		]);
	});

	it("ignores external dependencies not present in the proposal set", () => {
		const proposals = [proposal("proposal-1", ["proposal-999"])];
		const res = computeSequences(proposals);
		assert.strictEqual(res.sequences.length, 1);
		expect(mustGet(res.sequences, 0).proposals.map((t) => t.id)).toEqual([
			"proposal-1",
		]);
	});
});
