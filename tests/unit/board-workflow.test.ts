import { describe, it } from "node:test";
import {
	filterProposalsForWorkflow,
	getWorkflowViewDefinition,
	getWorkflowViewForProposal,
	resolveWorkflowStatuses,
} from "../../src/ui/board.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("board workflow helpers", () => {
	it("maps proposal types to workflow views", () => {
		expect(
			getWorkflowViewForProposal({
				id: "p1",
				title: "RFC",
				status: "Draft",
				proposalType: "product",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			} as Proposal).key,
		).toBe("rfc");
		expect(
			getWorkflowViewForProposal({
				id: "p2",
				title: "Fix",
				status: "TRIAGE",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			} as Proposal).key,
		).toBe("quick-fix");
		expect(
			getWorkflowViewForProposal({
				id: "p3",
				title: "Hotfix",
				status: "DONE",
				proposalType: "hotfix",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			} as Proposal).key,
		).toBe("hotfix");
		expect(
			getWorkflowViewForProposal({
				id: "p4",
				title: "Fallback",
				status: "Review",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			} as Proposal).key,
		).toBe("rfc");
	});

	it("filters proposals to the active workflow", () => {
		const proposals: Proposal[] = [
			{
				id: "p1",
				title: "RFC",
				status: "Draft",
				proposalType: "product",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p2",
				title: "Fix",
				status: "TRIAGE",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		expect(filterProposalsForWorkflow(proposals, "rfc")).toHaveLength(1);
		expect(filterProposalsForWorkflow(proposals, "quick-fix")).toHaveLength(1);
	});

	it("keeps workflow column order and sorts custom states deterministically", () => {
		const workflow = getWorkflowViewDefinition("rfc");
		const proposals: Proposal[] = [
			{
				id: "p1",
				title: "RFC",
				status: "Draft",
				proposalType: "product",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p2",
				title: "RFC2",
				status: "REVIEW",
				proposalType: "feature",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p3",
				title: "RFC3",
				status: "Blocked",
				proposalType: "feature",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		expect(resolveWorkflowStatuses(proposals, workflow.key)).toEqual([
			"Draft",
			"Review",
			"Develop",
			"Merge",
			"Complete",
			"Blocked",
		]);
	});
});
