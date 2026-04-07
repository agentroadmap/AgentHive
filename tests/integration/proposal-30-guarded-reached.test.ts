/**
 * proposal-30: Guarded Complete Transition Tests (RELAXED - proposal-37)
 *
 * proposal-37 removed hard gates from Complete transition.
 * These tests now verify that the gates NO LONGER exist.
 *
 * Relaxed ACs (from proposal-37):
 * - AC #1: Complete transition no longer requires proof of arrival entries
 * - AC #2: Complete transition no longer requires peer audit or verification proposalments
 * - AC #3: Complete transition no longer requires finalSummary
 * - AC #4: Maturity levels no longer gate status transitions
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("proposal-30/37: Guarded Complete Transition (Gates Removed)", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-guarded-complete-relaxed");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	// Helper to set up a proposal ready for Complete (builder + auditor + auditNotes)
	async function setupAuditedProposal(title: string) {
		const { proposal } = await core.createProposalFromInput({
			title,
			status: "Potential",
		});
		await core.updateProposalFromInput(proposal.id, {
			builder: "@builder",
			auditor: "@peer-tester",
			auditNotes: "All checks passed",
		});
		return proposal;
	}

	describe("Gates Removed: Complete transition is now trust-based", () => {
		it("should ALLOW Complete transition without maturity=audited (gate removed)", async () => {
			const proposal = await setupAuditedProposal("Test Proposal");

			// This now succeeds - previously would reject
			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
				maturity: "contracted",
			});

			assert.strictEqual(result.status, "Complete");
		});

		it("should ALLOW Complete transition without Proof of Arrival (gate removed)", async () => {
			const proposal = await setupAuditedProposal("Test Proposal");

			// This now succeeds - previously would reject
			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
				maturity: "audited",
				finalSummary: "Done",
			});

			assert.strictEqual(result.status, "Complete");
		});

		it("should ALLOW Complete transition without Final Summary (gate removed)", async () => {
			const proposal = await setupAuditedProposal("Test Proposal");

			// This now succeeds - previously would reject
			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
				maturity: "audited",
				addProof: ["test passed"],
			});

			assert.strictEqual(result.status, "Complete");
		});

		it("should allow Complete transition with all requirements met", async () => {
			const proposal = await setupAuditedProposal("Test Proposal");

			const result = await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
				maturity: "audited",
				addProof: ["test passed"],
				finalSummary: "Implementation complete",
			});

			assert.strictEqual(result.status, "Complete");
		});
	});

	describe("Maturity=audited validation still exists for integrity", () => {
		it("should still validate peer audit when setting maturity=audited", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test",
				status: "Potential",
			});

			// This should still reject - setting maturity=audited requires distinct builder/auditor
			await assert.rejects(
				() =>
					core.updateProposalFromInput(proposal.id, {
						builder: "@same",
						auditor: "@same",
						auditNotes: "Self-review",
						maturity: "audited",
					}),
				/Peer Audit requires distinct agents/i,
			);
		});

		it("should accept audited maturity with distinct builder and auditor", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test",
				status: "Potential",
			});

			const result = await core.updateProposalFromInput(proposal.id, {
				builder: "@builder",
				auditor: "@peer-tester",
				auditNotes: "Looks good",
				maturity: "audited",
			});

			assert.strictEqual(result.maturity, "audited");
		});
	});

	describe("Reopen workflow", () => {
		it("should allow reopening Complete proposal to Active", async () => {
			const proposal = await setupAuditedProposal("Test Proposal");

			await core.updateProposalFromInput(proposal.id, {
				status: "Complete",
				maturity: "audited",
				addProof: ["test passed"],
				finalSummary: "Implementation complete",
			});

			// Reopen
			const reopened = await core.updateProposalFromInput(proposal.id, {
				status: "Active",
			});

			assert.strictEqual(reopened.status, "Active");
		});
	});

	describe("Audit notes requirement for maturity=audited", () => {
		it("should reject audited maturity without audit notes", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test",
				status: "Potential",
			});

			await assert.rejects(
				() =>
					core.updateProposalFromInput(proposal.id, {
						builder: "@builder",
						auditor: "@peer",
						maturity: "audited",
					}),
				/audit notes/i,
			);
		});
	});
});
