import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type CrossProjectEdge,
	detectCycles,
} from "../../src/core/cross-project/cross-project-dependency-checker.ts";

function makeEdge(
	edgeId: number,
	fromProject: number,
	fromProposal: number,
	toProject: number,
	toProposal: number,
	kind = "blocks",
): CrossProjectEdge {
	return {
		edgeId: BigInt(edgeId),
		fromProjectId: BigInt(fromProject),
		fromProposalId: BigInt(fromProposal),
		toProjectId: BigInt(toProject),
		toProposalId: BigInt(toProposal),
		kind,
	};
}

describe("P602: detectCycles — cross-project BFS", () => {
	it("returns empty for acyclic graph", () => {
		// P1:1 → P2:2 → P3:3 (no cycle)
		const edges = [makeEdge(1, 1, 1, 2, 2), makeEdge(2, 2, 2, 3, 3)];
		assert.deepStrictEqual(detectCycles(edges), []);
	});

	it("detects a simple two-node cycle", () => {
		// P1:1 → P2:2 → P1:1 (cycle)
		const edges = [makeEdge(1, 1, 1, 2, 2), makeEdge(2, 2, 2, 1, 1)];
		const cycles = detectCycles(edges);
		assert.equal(cycles.length, 1);
		assert.equal(cycles[0].hasCycle, true);
		assert.ok(cycles[0].cycleEdgeIds.length > 0);
	});

	it("detects a three-node cycle", () => {
		// P1:1 → P2:2 → P3:3 → P1:1
		const edges = [
			makeEdge(1, 1, 1, 2, 2),
			makeEdge(2, 2, 2, 3, 3),
			makeEdge(3, 3, 3, 1, 1),
		];
		const cycles = detectCycles(edges);
		assert.ok(cycles.length >= 1);
		assert.ok(cycles.every((c) => c.hasCycle));
	});

	it("returns empty for empty edge list", () => {
		assert.deepStrictEqual(detectCycles([]), []);
	});

	it("does not detect self-loops (excluded by DB CHECK constraint)", () => {
		// Self-loops (same project_id) cannot enter the DB; this confirms
		// the checker handles same-project-id gracefully if called directly.
		const edges = [makeEdge(1, 1, 1, 1, 1)];
		// P1:1 → P1:1 is a self-cycle; the cycle check should catch it
		const cycles = detectCycles(edges);
		assert.ok(cycles.length >= 1);
	});

	it("handles disconnected graph without false positives", () => {
		// Two independent chains, no cycles
		const edges = [makeEdge(1, 1, 1, 2, 2), makeEdge(3, 3, 3, 4, 4)];
		assert.deepStrictEqual(detectCycles(edges), []);
	});

	it("cycle edge IDs reference the edges that form the cycle", () => {
		// P1:1 → P2:2 (edge 10), P2:2 → P1:1 (edge 11)
		const edges = [makeEdge(10, 1, 1, 2, 2), makeEdge(11, 2, 2, 1, 1)];
		const cycles = detectCycles(edges);
		assert.equal(cycles.length, 1);
		assert.ok(
			cycles[0].cycleEdgeIds.includes(BigInt(10)) ||
				cycles[0].cycleEdgeIds.includes(BigInt(11)),
		);
	});
});
