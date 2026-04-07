import { describe, it } from "node:test";
import { canMoveToUnsequenced } from "../../src/core/proposal/sequences.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

function t(
	id: string,
	deps: string[] = [],
	extra: Partial<Proposal> = {},
): Proposal {
	return {
		id,
		title: id,
		status: "Potential",
		assignee: [],
		createdDate: "2025-01-01",
		labels: [],
		dependencies: deps,
		rawContent: "Test",
		...extra,
	};
}

describe("canMoveToUnsequenced", () => {
	it("returns true for isolated proposals (no deps, no dependents)", () => {
		const proposals = [t("proposal-1"), t("proposal-2")];
		expect(canMoveToUnsequenced(proposals, "proposal-2")).toBe(true);
	});

	it("returns false when proposal has dependencies", () => {
		const proposals = [t("proposal-1"), t("proposal-2", ["proposal-1"])];
		expect(canMoveToUnsequenced(proposals, "proposal-2")).toBe(false);
	});

	it("returns false when proposal has dependents", () => {
		const proposals = [t("proposal-1"), t("proposal-2", ["proposal-1"])];
		expect(canMoveToUnsequenced(proposals, "proposal-1")).toBe(false);
	});
});
