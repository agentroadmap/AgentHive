import assert from "node:assert";
import { describe, it } from "node:test";
import type { Proposal } from "../../src/types/index.ts";
import {
	createKanbanSharedFilters,
	createUnifiedViewFilters,
	filterProposalsForKanban,
	mergeUnifiedViewFilters,
	type UnifiedViewFilters,
} from "../../src/ui/unified-view.ts";
import { applyProposalFilters } from "../../src/utils/proposal-search.ts";

describe("unified view filter proposal", () => {
	it("initializes directive filter from options", () => {
		const labels = ["backend"];
		const filters = createUnifiedViewFilters({
			searchQuery: "sync",
			status: "Active",
			priority: "high",
			labels,
			directive: "Release 1",
		});

		assert.strictEqual(filters.searchQuery, "sync");
		assert.strictEqual(filters.statusFilter, "Active");
		assert.strictEqual(filters.priorityFilter, "high");
		assert.deepStrictEqual(filters.labelFilter, ["backend"]);
		assert.strictEqual(filters.directiveFilter, "Release 1");
		assert.notStrictEqual(filters.labelFilter, labels);
	});

	it("preserves directive filter when merging filter updates", () => {
		const initial = createUnifiedViewFilters({
			searchQuery: "api",
			status: "Potential",
			priority: "",
			labels: [],
		});

		const updated: UnifiedViewFilters = {
			searchQuery: "api",
			statusFilter: "Potential",
			priorityFilter: "",
			labelFilter: ["infra"],
			directiveFilter: "Sprint 7",
		};

		const merged = mergeUnifiedViewFilters(initial, updated);
		assert.strictEqual(merged.directiveFilter, "Sprint 7");
		assert.deepStrictEqual(merged.labelFilter, ["infra"]);
		assert.notStrictEqual(merged.labelFilter, updated.labelFilter);
		assert.strictEqual(initial.directiveFilter, "");
	});

	it("excludes status from kanban shared filters", () => {
		const unified = createUnifiedViewFilters({
			searchQuery: "sync",
			status: "Complete",
			priority: "high",
			labels: ["ui"],
			directive: "Sprint 1",
		});

		const shared = createKanbanSharedFilters(unified);
		assert.strictEqual(shared.searchQuery, "sync");
		assert.strictEqual(shared.priorityFilter, "high");
		assert.deepStrictEqual(shared.labelFilter, ["ui"]);
		assert.strictEqual(shared.directiveFilter, "Sprint 1");
		assert.strictEqual("statusFilter" in shared, false);
	});

	it("keeps shared filter results consistent between proposal list and kanban", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "UI polish",
				status: "Potential",
				priority: "high",
				labels: ["ui"],
				directive: "m-1",
				assignee: [],
				createdDate: "2026-01-01",
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "UI review",
				status: "Complete",
				priority: "high",
				labels: ["ui"],
				directive: "m-1",
				assignee: [],
				createdDate: "2026-01-02",
				dependencies: [],
			},
			{
				id: "proposal-3",
				title: "Backend migration",
				status: "Potential",
				priority: "low",
				labels: ["backend"],
				directive: "m-2",
				assignee: [],
				createdDate: "2026-01-03",
				dependencies: [],
			},
		];
		const resolveDirectiveLabel = (directive: string) => {
			if (directive.toLowerCase() === "m-1") return "Sprint 1";
			if (directive.toLowerCase() === "m-2") return "Sprint 2";
			return directive;
		};

		const sharedFilters = {
			searchQuery: "",
			priorityFilter: "high",
			labelFilter: ["ui"],
			directiveFilter: "Sprint 1",
		};

		const kanbanResults = filterProposalsForKanban(
			proposals,
			sharedFilters,
			resolveDirectiveLabel,
		).map((proposal) => proposal.id);
		const listSharedResults = applyProposalFilters(proposals, {
			priority: "high",
			labels: ["ui"],
			directive: "Sprint 1",
			resolveDirectiveLabel,
		}).map((proposal) => proposal.id);
		const listStatusResults = applyProposalFilters(proposals, {
			status: "Potential",
			priority: "high",
			labels: ["ui"],
			directive: "Sprint 1",
			resolveDirectiveLabel,
		}).map((proposal) => proposal.id);

		assert.deepStrictEqual(kanbanResults, ["proposal-1", "proposal-2"]);
		assert.deepStrictEqual(listSharedResults, ["proposal-1", "proposal-2"]);
		assert.deepStrictEqual(listStatusResults, ["proposal-1"]);
	});
});
