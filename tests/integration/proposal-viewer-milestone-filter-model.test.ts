import assert from "node:assert";
import { describe, it } from "node:test";
import type { Directive } from "../../src/types/index.ts";
import { buildProposalViewerDirectiveFilterModel } from "../../src/ui/proposal-viewer-with-search.ts";
import { expect } from "../support/test-utils.ts";

describe("proposal viewer directive filter model", () => {
	it("builds filter options from active directives", () => {
		const directives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
			{ id: "m-2", title: "Release 2", description: "", rawContent: "" },
		];

		const model = buildProposalViewerDirectiveFilterModel(directives);
		assert.deepStrictEqual(model.availableDirectiveTitles, [
			"Release 1",
			"Release 2",
		]);
	});

	it("resolves only configured directive aliases and leaves unknown directive ids unchanged", () => {
		const directives: Directive[] = [
			{ id: "m-3", title: "Sprint 3", description: "", rawContent: "" },
		];
		const model = buildProposalViewerDirectiveFilterModel(directives);

		expect(model.resolveDirectiveLabel("m-3")).toBe("Sprint 3");
		expect(model.resolveDirectiveLabel("3")).toBe("Sprint 3");
		expect(model.resolveDirectiveLabel("m-99")).toBe("m-99");
	});
});
