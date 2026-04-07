/**
 * Tests for proposal-60: Proposal Workflow - Mature Potential Through Research & Approval
 *
 * AC#1: Potential components can be promoted to 'Proposed' status with research document
 * AC#2: Product Manager reviews proposal for product-market fit
 * AC#3: Architect reviews proposal for technical feasibility
 * AC#4: Both PM + Architect approval required before 'Approved' status
 * AC#5: Only Approved components can be claimed for Active work
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	addReview,
	approveProposal,
	canClaimProposal,
	claimApprovedProposal,
	generateProposalTemplate,
	getAllProposals,
	getProposal,
	getProposalByProposalId,
	getProposalReviews,
	getProposalSummary,
	getProposalsByStatus,
	hasReviewType,
	type Proposal,
	rejectProposal,
	resetProposals,
	saveProposals,
	submitProposal,
} from "../../src/core/collaboration/proposal-workflow.ts";

describe("proposal-60: Proposal Workflow - Mature Potential Through Research & Approval", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "proposal-test-"));
		resetProposals();
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch (_e) {
			// Ignore cleanup errors
		}
	});

	describe("AC#1: Potential components can be promoted to 'Proposed' status", () => {
		it("should submit a proposal for a potential proposal", () => {
			const proposal = submitProposal("proposal-10", {
				title: "New Feature",
				description: "A great new feature",
				research: "# Research\n\nDetailed analysis...",
				submittedBy: "alice",
			});

			assert.ok(proposal.id);
			assert.strictEqual(proposal.proposalId, "proposal-10");
			assert.strictEqual(proposal.title, "New Feature");
			assert.strictEqual(proposal.status, "proposed");
			assert.strictEqual(proposal.submittedBy, "alice");
		});

		it("should require research document", () => {
			const proposal = submitProposal("proposal-11", {
				title: "Feature with Research",
				description: "Description",
				research: "# Research Document\n\nSome research...",
				submittedBy: "bob",
			});

			assert.ok(proposal.research);
			assert.ok(proposal.research.length > 0);
		});

		it("should reject duplicate proposals for same proposal", () => {
			submitProposal("proposal-12", {
				title: "First",
				description: "First proposal",
				research: "Research",
				submittedBy: "alice",
			});

			assert.throws(() => {
				submitProposal("proposal-12", {
					title: "Second",
					description: "Second proposal",
					research: "Research",
					submittedBy: "bob",
				});
			}, /already exists/);
		});

		it("should retrieve proposal by ID", () => {
			const proposal = submitProposal("proposal-20", {
				title: "Retrieve Test",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			const retrieved = getProposal(proposal.id);
			assert.ok(retrieved);
			assert.strictEqual(retrieved.proposalId, "proposal-20");
		});

		it("should retrieve proposal by proposal ID", () => {
			submitProposal("proposal-21", {
				title: "Proposal ID Lookup",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			const retrieved = getProposalByProposalId("proposal-21");
			assert.ok(retrieved);
			assert.strictEqual(retrieved.title, "Proposal ID Lookup");
		});

		it("should generate research document template", () => {
			const template = generateProposalTemplate("proposal-30", "New Feature");

			assert.ok(template.includes("proposal-30"));
			assert.ok(template.includes("New Feature"));
			assert.ok(template.includes("Problem Proposalment"));
			assert.ok(template.includes("Proposed Solution"));
			assert.ok(template.includes("Technical Approach"));
			assert.ok(template.includes("Product-Market Fit"));
			assert.ok(template.includes("Acceptance Criteria"));
		});
	});

	describe("AC#2: Product Manager reviews for product-market fit", () => {
		let proposal: Proposal;

		beforeEach(() => {
			proposal = submitProposal("proposal-PM", {
				title: "PM Review Test",
				description: "Test",
				research: "Research document",
				submittedBy: "alice",
			});
		});

		it("should allow PM to add product-market-fit review", () => {
			const review = addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "Good market fit for target users",
			});

			assert.ok(review.id);
			assert.strictEqual(review.type, "product-market-fit");
			assert.strictEqual(review.approved, true);
			assert.strictEqual(review.score, 8);
			assert.strictEqual(review.reviewer, "pm-alice");
		});

		it("should reject duplicate review of same type", () => {
			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "Good",
			});

			assert.throws(() => {
				addReview(proposal.id, {
					reviewer: "pm-bob",
					type: "product-market-fit",
					approved: true,
					score: 7,
					comments: "Also good",
				});
			}, /already exists/);
		});

		it("should clamp score between 1 and 10", () => {
			const review = addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 15, // Too high
				comments: "Test",
			});

			assert.strictEqual(review.score, 10);
		});

		it("should retrieve reviews for a proposal", () => {
			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "PM review",
			});

			const reviews = getProposalReviews(proposal.id);
			assert.strictEqual(reviews.length, 1);
			assert.strictEqual(reviews[0].type, "product-market-fit");
		});
	});

	describe("AC#3: Architect reviews for technical feasibility", () => {
		let proposal: Proposal;

		beforeEach(() => {
			proposal = submitProposal("proposal-ARCH", {
				title: "Arch Review Test",
				description: "Test",
				research: "Research",
				submittedBy: "bob",
			});
		});

		it("should allow Architect to add technical-feasibility review", () => {
			const review = addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Technically sound approach",
			});

			assert.strictEqual(review.type, "technical-feasibility");
			assert.strictEqual(review.approved, true);
			assert.strictEqual(review.reviewer, "architect-bob");
		});

		it("should track review type correctly", () => {
			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Good",
			});

			assert.strictEqual(
				hasReviewType(proposal.id, "technical-feasibility"),
				true,
			);
			assert.strictEqual(
				hasReviewType(proposal.id, "product-market-fit"),
				false,
			);
		});

		it("should not approve with only technical review", () => {
			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Good",
			});

			const updated = getProposal(proposal.id)!;
			assert.strictEqual(updated.status, "proposed"); // Still proposed, needs PM review
		});
	});

	describe("AC#4: Both PM + Architect approval required before 'Approved' status", () => {
		let proposal: Proposal;

		beforeEach(() => {
			proposal = submitProposal("proposal-DUAL", {
				title: "Dual Approval Test",
				description: "Test",
				research: "Research",
				submittedBy: "carol",
			});
		});

		it("should auto-approve when both reviews pass", () => {
			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "PM approved",
			});

			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Arch approved",
			});

			const updated = getProposal(proposal.id)!;
			assert.strictEqual(updated.status, "approved");
			assert.ok(updated.approvedAt);
		});

		it("should not auto-approve if PM rejects", () => {
			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: false,
				score: 3,
				comments: "Bad market fit",
			});

			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Good tech",
			});

			const updated = getProposal(proposal.id)!;
			assert.strictEqual(updated.status, "proposed");
		});

		it("should not auto-approve if Architect rejects", () => {
			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "Good",
			});

			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: false,
				score: 2,
				comments: "Technically risky",
			});

			const updated = getProposal(proposal.id)!;
			assert.strictEqual(updated.status, "proposed");
		});

		it("should manually approve when needed", () => {
			const approved = approveProposal(proposal.id, "manual-reviewer");

			assert.strictEqual(approved.status, "approved");
			assert.strictEqual(approved.approvedBy, "manual-reviewer");
		});

		it("should reject proposal with reason", () => {
			const rejected = rejectProposal(proposal.id, "Not aligned with roadmap");

			assert.strictEqual(rejected.status, "rejected");
			assert.strictEqual(rejected.reviews.length, 1);
			assert.strictEqual(
				rejected.reviews[0].comments,
				"Not aligned with roadmap",
			);
		});
	});

	describe("AC#5: Only Approved components can be claimed for Active work", () => {
		it("should allow claiming approved proposal", () => {
			const proposal = submitProposal("proposal-CLAIM", {
				title: "Claim Test",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			addReview(proposal.id, {
				reviewer: "pm-alice",
				type: "product-market-fit",
				approved: true,
				score: 8,
				comments: "Good",
			});

			addReview(proposal.id, {
				reviewer: "architect-bob",
				type: "technical-feasibility",
				approved: true,
				score: 9,
				comments: "Good",
			});

			const result = claimApprovedProposal("proposal-CLAIM", "developer-carol");

			assert.strictEqual(result.success, true);
			assert.strictEqual(result.claimedBy, "developer-carol");
		});

		it("should reject claiming unapproved proposal", () => {
			submitProposal("proposal-UNAPPROVED", {
				title: "Unapproved",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			const result = claimApprovedProposal(
				"proposal-UNAPPROVED",
				"developer-carol",
			);

			assert.strictEqual(result.success, false);
			assert.ok(result.message.includes("not approved"));
		});

		it("should reject claiming proposal without proposal", () => {
			const result = claimApprovedProposal(
				"proposal-NONEXISTENT",
				"developer-carol",
			);

			assert.strictEqual(result.success, false);
			assert.ok(result.message.includes("No proposal found"));
		});

		it("should check if proposal can be claimed", () => {
			const proposal = submitProposal("proposal-CHECK", {
				title: "Check Test",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			assert.strictEqual(canClaimProposal("proposal-CHECK"), false);

			approveProposal(proposal.id);
			assert.strictEqual(canClaimProposal("proposal-CHECK"), true);
		});
	});

	describe("Querying and persistence", () => {
		it("should get all proposals", () => {
			submitProposal("proposal-A", {
				title: "A",
				description: "",
				research: "R",
				submittedBy: "x",
			});
			submitProposal("proposal-B", {
				title: "B",
				description: "",
				research: "R",
				submittedBy: "y",
			});

			const all = getAllProposals();
			assert.ok(all.length >= 2);
		});

		it("should filter proposals by status", () => {
			const p1 = submitProposal("proposal-STATUS1", {
				title: "A",
				description: "",
				research: "R",
				submittedBy: "x",
			});
			submitProposal("proposal-STATUS2", {
				title: "B",
				description: "",
				research: "R",
				submittedBy: "y",
			});
			approveProposal(p1.id);

			const proposed = getProposalsByStatus("proposed");
			const approved = getProposalsByStatus("approved");

			assert.ok(proposed.length >= 1);
			assert.ok(approved.length >= 1);
		});

		it("should save and load proposals", () => {
			const filePath = join(testDir, "proposals.json");

			submitProposal("proposal-PERSIST", {
				title: "Persistence Test",
				description: "Test",
				research: "Research",
				submittedBy: "alice",
			});

			saveProposals(filePath);
			assert.strictEqual(existsSync(filePath), true);
		});

		it("should get proposal summary", () => {
			const summary = getProposalSummary();

			assert.ok(Object.hasOwn(summary, "proposed"));
			assert.ok(Object.hasOwn(summary, "approved"));
			assert.ok(Object.hasOwn(summary, "rejected"));
			assert.ok(Object.hasOwn(summary, "total"));
			assert.strictEqual(
				summary.total,
				summary.proposed + summary.approved + summary.rejected,
			);
		});
	});
});
