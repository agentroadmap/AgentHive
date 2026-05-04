import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type CrossProjectEdge,
	detectCycles,
} from "../../src/core/cross-project/cross-project-dependency-checker.ts";

function makeEdge(
	edgeId: number,
	fromProject: number,
	toProject: number,
	kindId = 1,
	referenceId = "ref-1",
	referenceType = "proposal",
	isBlocking = true,
): CrossProjectEdge {
	return {
		edgeId: BigInt(edgeId),
		fromProjectId: BigInt(fromProject),
		toProjectId: BigInt(toProject),
		kindId: BigInt(kindId),
		referenceId,
		referenceType,
		isBlocking,
	};
}

describe("P602: detectCycles — cross-project BFS", () => {
	it("returns empty for acyclic graph", () => {
		// project 1 → 2 → 3 (no cycle)
		const edges = [makeEdge(1, 1, 2), makeEdge(2, 2, 3)];
		assert.deepStrictEqual(detectCycles(edges), []);
	});

	it("detects a simple two-node cycle", () => {
		// project 1 → 2 → 1 (cycle)
		const edges = [makeEdge(1, 1, 2), makeEdge(2, 2, 1)];
		const cycles = detectCycles(edges);
		assert.equal(cycles.length, 1);
		assert.equal(cycles[0].hasCycle, true);
		assert.ok(cycles[0].cycleEdgeIds.length > 0);
	});

	it("detects a three-node cycle", () => {
		// project 1 → 2 → 3 → 1
		const edges = [makeEdge(1, 1, 2), makeEdge(2, 2, 3), makeEdge(3, 3, 1)];
		const cycles = detectCycles(edges);
		assert.ok(cycles.length >= 1);
		assert.ok(cycles.every((c) => c.hasCycle));
	});

	it("returns empty for empty edge list", () => {
		assert.deepStrictEqual(detectCycles([]), []);
	});

	it("detects self-loops (same project_id in from and to)", () => {
		// project 1 → 1 is a self-cycle
		const edges = [makeEdge(1, 1, 1)];
		const cycles = detectCycles(edges);
		assert.ok(cycles.length >= 1);
	});

	it("handles disconnected graph without false positives", () => {
		// Two independent chains, no cycles
		const edges = [makeEdge(1, 1, 2), makeEdge(3, 3, 4)];
		assert.deepStrictEqual(detectCycles(edges), []);
	});

	it("cycle edge IDs reference the edges that form the cycle", () => {
		// project 1 → 2 (edge 10), project 2 → 1 (edge 11)
		const edges = [makeEdge(10, 1, 2), makeEdge(11, 2, 1)];
		const cycles = detectCycles(edges);
		assert.equal(cycles.length, 1);
		assert.ok(
			cycles[0].cycleEdgeIds.includes(BigInt(10)) ||
				cycles[0].cycleEdgeIds.includes(BigInt(11)),
		);
	});
});
