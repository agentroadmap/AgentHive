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
				status: "DRAFT",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			} as Proposal).key,
		).toBe("rfc");
		expect(
			getWorkflowViewForProposal({
				id: "p3",
				title: "Hotfix",
				status: "DEPLOYED",
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

	it("filters proposals to the active workflow and separates obsolete items", () => {
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
				title: "Legacy Fix",
				status: "TRIAGE",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
				maturity: "obsolete",
			},
			{
				id: "p3",
				title: "Done",
				status: "DONE",
				proposalType: "hotfix",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		expect(filterProposalsForWorkflow(proposals, "all")).toHaveLength(2);
		expect(filterProposalsForWorkflow(proposals, "obsolete")).toHaveLength(1);
		expect(filterProposalsForWorkflow(proposals, "rfc")).toHaveLength(1);
		expect(filterProposalsForWorkflow(proposals, "quick-fix")).toHaveLength(0);
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

	it("routes legacy issue states into the compatibility quick-fix view", () => {
		const proposals: Proposal[] = [
			{
				id: "p1",
				title: "Legacy Fix",
				status: "FIXING",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p2",
				title: "Legacy Done",
				status: "DONE",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p3",
				title: "Current Issue",
				status: "DRAFT",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		expect(getWorkflowViewForProposal(proposals[0]).key).toBe("quick-fix");
		expect(getWorkflowViewForProposal(proposals[1]).key).toBe("quick-fix");
		expect(getWorkflowViewForProposal(proposals[2]).key).toBe("rfc");
		expect(resolveWorkflowStatuses(proposals, "quick-fix")).toEqual([
			"TRIAGE",
			"FIX",
			"DEPLOYED",
			"ESCALATE",
			"WONT_FIX",
			"NON_ISSUE",
		]);
	});

	it("combines workflow status columns for the all view", () => {
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
				title: "Issue",
				status: "DRAFT",
				proposalType: "issue",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "p3",
				title: "Hotfix",
				status: "DEPLOYED",
				proposalType: "hotfix",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		expect(resolveWorkflowStatuses(proposals, "all")).toEqual([
			"Draft",
			"Review",
			"Develop",
			"Merge",
			"Complete",
			"TRIAGE",
			"FIX",
			"DEPLOYED",
			"ESCALATE",
			"WONT_FIX",
			"NON_ISSUE",
		]);
	});
});
