import { describe, it } from "node:test";
import { reorderWithinSequence } from "../../src/core/proposal/sequences.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

function t(id: string, ordinal?: number): Proposal {
	return {
		id,
		title: id,
		status: "Potential",
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: [],
		rawContent: "Test",
		...(ordinal !== undefined ? { ordinal } : {}),
	};
}

describe("reorderWithinSequence", () => {
	it("reassigns ordinals within a sequence and leaves others untouched", () => {
		const proposals: Proposal[] = [
			t("proposal-1", 0),
			t("proposal-2", 1),
			t("proposal-3", 2),
			t("proposal-9"), // outside this sequence
		];
		const updated = reorderWithinSequence(
			proposals,
			["proposal-1", "proposal-2", "proposal-3"],
			"proposal-3",
			0,
		);
		const byId = new Map(updated.map((x) => [x.id, x]));
		expect(byId.get("proposal-3")?.ordinal).toBe(0);
		expect(byId.get("proposal-1")?.ordinal).toBe(1);
		expect(byId.get("proposal-2")?.ordinal).toBe(2);
		expect(byId.get("proposal-9")?.ordinal).toBeUndefined();
	});

	it("clamps index and preserves dependencies", () => {
		const proposals: Proposal[] = [
			{ ...t("proposal-1", 0), dependencies: ["proposal-x"] },
			t("proposal-2", 1),
		];
		const updated = reorderWithinSequence(
			proposals,
			["proposal-1", "proposal-2"],
			"proposal-1",
			10,
		);
		const byId = new Map(updated.map((x) => [x.id, x]));
		expect(byId.get("proposal-1")?.ordinal).toBe(1);
		expect(byId.get("proposal-1")?.dependencies).toEqual(["proposal-x"]);
	});
});
