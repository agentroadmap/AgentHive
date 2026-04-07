import { describe, it } from "node:test";
import {
	adjustDependenciesForMove,
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

describe("adjustDependenciesForMove (join semantics)", () => {
	it("sets moved proposal deps to previous sequence proposals and does not modify next sequence", () => {
		// seq1: 1,2 ; seq2: 3(dep:1,2) ; seq3: 4(dep:3)
		const proposals = [
			t("proposal-1"),
			t("proposal-2"),
			t("proposal-3", ["proposal-1", "proposal-2"]),
			t("proposal-4", ["proposal-3"]),
		];
		const res = computeSequences(proposals);
		const seqs = res.sequences;

		// Move proposal-3 to sequence 1 (target index = 1)
		const updated = adjustDependenciesForMove(proposals, seqs, "proposal-3", 1);
		const byId = new Map(updated.map((x) => [x.id, x]));

		// Moved deps should be from previous sequence (none)
		expect(byId.get("proposal-3")?.dependencies).toEqual([]);

		// Next sequence unchanged (no forced dependency to moved)
		expect(byId.get("proposal-4")?.dependencies).toEqual(["proposal-3"]);
	});

	it("keeps deps and does not add duplicates to next sequence", () => {
		// seq1: 1 ; seq2: 2(dep:1), 3(dep:1) ; seq3: 4(dep:2,3)
		const proposals = [
			t("proposal-1"),
			t("proposal-2", ["proposal-1"]),
			t("proposal-3", ["proposal-1"]),
			t("proposal-4", ["proposal-2", "proposal-3"]),
		];
		const res = computeSequences(proposals);
		const seqs = res.sequences;

		// Move proposal-2 to seq2 (target=2) -> prev seq = seq1 -> deps should be [proposal-1]
		const updated = adjustDependenciesForMove(proposals, seqs, "proposal-2", 2);
		const byId = new Map(updated.map((x) => [x.id, x]));
		expect(byId.get("proposal-2")?.dependencies).toEqual(["proposal-1"]);
		// proposal-4 unchanged
		expect(byId.get("proposal-4")?.dependencies).toEqual([
			"proposal-2",
			"proposal-3",
		]);
	});
});
