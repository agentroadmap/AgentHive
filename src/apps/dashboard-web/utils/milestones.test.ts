import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildDirectiveBuckets,
	collectDirectiveIds,
	validateDirectiveName,
} from "../../../core/proposal/directives";
import type { Directive, Proposal } from "../../../shared/types";

const makeProposal = (overrides: Partial<Proposal>): Proposal => ({
	id: "proposal-1",
	title: "Proposal",
	status: "Potential",
	assignee: [],
	labels: [],
	dependencies: [],
	createdDate: "2024-01-01",
	...overrides,
});

describe("buildDirectiveBuckets", () => {
	const proposals = [
		makeProposal({ id: "proposal-1", directive: "M1", status: "Potential" }),
		makeProposal({ id: "proposal-2", directive: "M2", status: "Active" }),
		makeProposal({ id: "proposal-3", status: "Reached" }),
	];

	it("returns buckets for file directives, discovered directives, and no-directive", () => {
		const directives: Directive[] = [
			{ id: "M1", title: "M1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(proposals, directives, [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		const labels = buckets.map((b: { label: string }) => b.label);
		assert.deepEqual(labels, ["Proposals without directive", "M1", "M2"]);
	});

	it("calculates status counts per bucket", () => {
		const directives: Directive[] = [
			{ id: "M1", title: "M1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(proposals, directives, [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		const m1 = buckets.find((b: { label: string }) => b.label === "M1");
		const none = buckets.find(
			(b: { isNoDirective?: boolean }) => b.isNoDirective,
		);
		assert.equal((m1 as any)?.statusCounts.Potential, 1);
		assert.equal((none as any)?.statusCounts.Reached, 1);
	});

	it("marks directives completed when all proposals are done", () => {
		const completedProposals = [
			makeProposal({ id: "proposal-1", directive: "M1", status: "Reached" }),
			makeProposal({ id: "proposal-2", directive: "M1", status: "Reached" }),
		];
		const directives: Directive[] = [
			{ id: "M1", title: "M1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(completedProposals, directives, [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		const m1 = buckets.find((b: { label: string }) => b.label === "M1");
		assert.equal((m1 as any)?.isCompleted, true);
	});

	it("keeps active directives when archived titles are reused", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", directive: "m-2", status: "Potential" }),
		];
		const directives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
			{ id: "m-2", title: "Release 1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(
			proposals,
			directives,
			["Potential", "Reached"],
			{
				archivedDirectiveIds: ["m-1", "Release 1"],
			},
		);
		const active = buckets.find(
			(bucket: { directive?: string }) => bucket.directive === "m-2",
		);
		assert.equal((active as any)?.label, "Release 1");
	});

	it("canonicalizes reused archived titles to the active directive ID", () => {
		const proposals = [
			makeProposal({
				id: "proposal-1",
				directive: "Release 1",
				status: "Potential",
			}),
			makeProposal({ id: "proposal-2", directive: "m-2", status: "Reached" }),
		];
		const directives: Directive[] = [
			{ id: "m-2", title: "Release 1", description: "", rawContent: "" },
		];
		const archivedDirectives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
		];

		const buckets = buildDirectiveBuckets(
			proposals,
			directives,
			["Potential", "Reached"],
			{
				archivedDirectiveIds: ["m-1"],
				archivedDirectives,
			},
		);
		const releaseBuckets = buckets.filter(
			(bucket: { label: string }) => bucket.label === "Release 1",
		);
		assert.equal(releaseBuckets.length, 1);
		assert.equal((releaseBuckets[0] as any)?.directive, "m-2");
		assert.deepEqual(
			(releaseBuckets[0] as any)?.proposals.map(
				(proposal: { id: string }) => proposal.id,
			),
			["proposal-1", "proposal-2"],
		);
	});

	it("canonicalizes numeric directive aliases to directive IDs", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", directive: "1", status: "Potential" }),
		];
		const directives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(proposals, directives, [
			"Potential",
			"Reached",
		]);
		const releaseBucket = buckets.find(
			(bucket: { directive?: string }) => bucket.directive === "m-1",
		);
		assert.deepEqual(
			(releaseBucket as any)?.proposals.map(
				(proposal: { id: string }) => proposal.id,
			),
			["proposal-1"],
		);
	});

	it("canonicalizes zero-padded directive ID aliases to canonical IDs", () => {
		const proposals = [
			makeProposal({
				id: "proposal-1",
				directive: "m-01",
				status: "Potential",
			}),
		];
		const directives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(proposals, directives, [
			"Potential",
			"Reached",
		]);
		const releaseBucket = buckets.find(
			(bucket: { directive?: string }) => bucket.directive === "m-1",
		);
		assert.deepEqual(
			(releaseBucket as any)?.proposals.map(
				(proposal: { id: string }) => proposal.id,
			),
			["proposal-1"],
		);
	});

	it("keeps active-title aliases when an archived directive ID shares the same key", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", directive: "m-0", status: "Potential" }),
		];
		const directives: Directive[] = [
			{ id: "m-2", title: "m-0", description: "", rawContent: "" },
		];
		const archivedDirectives: Directive[] = [
			{ id: "m-0", title: "Historical", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(
			proposals,
			directives,
			["Potential", "Reached"],
			{
				archivedDirectives,
				archivedDirectiveIds: ["m-0"],
			},
		);
		const noDirectiveBucket = buckets.find(
			(bucket: { isNoDirective?: boolean }) => bucket.isNoDirective,
		);
		assert.deepEqual(
			(noDirectiveBucket as any)?.proposals.map(
				(proposal: { id: string }) => proposal.id,
			),
			["proposal-1"],
		);
	});

	it("prefers real directive IDs over numeric title aliases", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", directive: "1", status: "Potential" }),
		];
		const directives: Directive[] = [
			{ id: "m-1", title: "Release 1", description: "", rawContent: "" },
			{ id: "m-2", title: "1", description: "", rawContent: "" },
		];
		const buckets = buildDirectiveBuckets(proposals, directives, [
			"Potential",
			"Reached",
		]);
		const idBucket = buckets.find(
			(bucket: { directive?: string }) => bucket.directive === "m-1",
		);
		const titleBucket = buckets.find(
			(bucket: { directive?: string }) => bucket.directive === "m-2",
		);
		assert.deepEqual(
			(idBucket as any)?.proposals.map(
				(proposal: { id: string }) => proposal.id,
			),
			["proposal-1"],
		);
		assert.equal(((titleBucket as any)?.proposals ?? []).length, 0);
	});
});

describe("collectDirectiveIds", () => {
	const proposals = [
		makeProposal({ id: "proposal-1", directive: "M1" }),
		makeProposal({ id: "proposal-2", directive: "New" }),
		makeProposal({ id: "proposal-3" }),
	];
	const directives: Directive[] = [
		{ id: "M1", title: "M1", description: "", rawContent: "" },
	];

	it("merges file directives and discovered proposal directives without duplicates", () => {
		assert.deepEqual(collectDirectiveIds(proposals, directives), ["M1", "New"]);
	});

	it("normalizes whitespace and casing", () => {
		const variantProposals = [
			makeProposal({ id: "proposal-1", directive: "  m1  " }),
			makeProposal({ id: "proposal-2", directive: "New" }),
		];
		const result = collectDirectiveIds(variantProposals, directives);
		assert.deepEqual(result, ["M1", "New"]);
	});
});

describe("validateDirectiveName", () => {
	it("rejects empty names", () => {
		assert.equal(
			validateDirectiveName("   ", []),
			"Directive name cannot be empty.",
		);
	});

	it("rejects duplicates case-insensitively", () => {
		assert.equal(
			validateDirectiveName("Alpha", ["alpha", "Beta"]),
			"Directive already exists.",
		);
		assert.equal(
			validateDirectiveName(" beta  ", ["alpha", "Beta"]),
			"Directive already exists.",
		);
	});

	it("allows unique names", () => {
		assert.equal(validateDirectiveName("Release", ["alpha", "Beta"]), null);
	});
});
