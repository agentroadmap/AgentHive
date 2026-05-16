import { describe, it } from "node:test";
import {
	filterProposalsForWorkflow,
	getWorkflowViewDefinition,
	getWorkflowViewForProposal,
	resolveWorkflowStatuses,
} from "../../src/ui/board.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

const baseProposal = (overrides: Partial<Proposal>): Proposal => ({
	id: overrides.id ?? "p",
	title: overrides.title ?? "test",
	status: overrides.status ?? "DRAFT",
	assignee: [],
	createdDate: "",
	labels: [],
	dependencies: [],
	...overrides,
});

describe("board workflow helpers", () => {
	it("routes proposals into rfc, hotfix, or obsolete based on type and maturity", () => {
		// Status translation is gone but the hotfix tab is a type filter that
		// reuses the RFC stage columns — easier triage of operational fixes.
		expect(
			getWorkflowViewForProposal(
				baseProposal({ proposalType: "product", status: "Draft" }),
			).key,
		).toBe("rfc");
		expect(
			getWorkflowViewForProposal(
				baseProposal({ proposalType: "issue", status: "DRAFT" }),
			).key,
		).toBe("rfc");
		expect(
			getWorkflowViewForProposal(
				baseProposal({ proposalType: "hotfix", status: "COMPLETE" }),
			).key,
		).toBe("hotfix");
		expect(
			getWorkflowViewForProposal(baseProposal({ status: "Review" })).key,
		).toBe("rfc");
	});

	it("separates obsolete and hotfix proposals into their own views", () => {
		const proposals: Proposal[] = [
			baseProposal({ id: "p1", proposalType: "product", status: "Draft" }),
			baseProposal({
				id: "p2",
				proposalType: "feature",
				status: "DISCARDED",
				maturity: "obsolete",
			}),
			baseProposal({ id: "p3", proposalType: "hotfix", status: "COMPLETE" }),
		];

		expect(filterProposalsForWorkflow(proposals, "all")).toHaveLength(2);
		expect(filterProposalsForWorkflow(proposals, "obsolete")).toHaveLength(1);
		expect(filterProposalsForWorkflow(proposals, "rfc")).toHaveLength(1);
		expect(filterProposalsForWorkflow(proposals, "hotfix")).toHaveLength(1);
	});

	it("keeps workflow column order and sorts custom states deterministically", () => {
		const workflow = getWorkflowViewDefinition("rfc");
		const proposals: Proposal[] = [
			baseProposal({ id: "p1", proposalType: "product", status: "DRAFT" }),
			baseProposal({ id: "p2", proposalType: "feature", status: "REVIEW" }),
			baseProposal({ id: "p3", proposalType: "feature", status: "Blocked" }),
		];

		expect(resolveWorkflowStatuses(proposals, workflow.key)).toEqual([
			"DRAFT",
			"REVIEW",
			"DEVELOP",
			"MERGE",
			"COMPLETE",
			"BLOCKED",
		]);
	});

	it("re-labels hotfix-tab columns using SMDL stage names", () => {
		// Hotfix view: cosmetic re-mapping so columns read TRIAGE / DEPLOY /
		// CLOSED instead of the underlying RFC stage names. RFC view stays
		// DB-truth.
		const proposals: Proposal[] = [
			baseProposal({ id: "p1", proposalType: "hotfix", status: "DRAFT" }),
			baseProposal({ id: "p2", proposalType: "hotfix", status: "DEVELOP" }),
			baseProposal({ id: "p3", proposalType: "hotfix", status: "COMPLETE" }),
		];

		expect(resolveWorkflowStatuses(proposals, "hotfix")).toEqual([
			"TRIAGE",
			"DEPLOY",
			"CLOSED",
			"WONT_FIX",
			"NON_ISSUE",
		]);
		// RFC view of the same data still uses raw DB stages.
		const rfcStatuses = resolveWorkflowStatuses(proposals, "rfc");
		expect(rfcStatuses).not.toContain("TRIAGE");
		expect(rfcStatuses).not.toContain("DEPLOYED");
	});
});
