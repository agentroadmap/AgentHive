/**
 * STATE-60: Proposal Workflow - Mature New Through Research & Approval
 *
 * Formal proposal workflow to mature New components through research
 * and approval before they can be claimed.
 *
 * AC#1: New components can be promoted to 'Proposed' status with research document
 * AC#2: Product Manager reviews proposal for product-market fit
 * AC#3: Architect reviews proposal for technical feasibility
 * AC#4: Both PM + Architect approval required before 'Approved' status
 * AC#5: Only Approved components can be claimed for Active work
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Review type - either product-market-fit or technical-feasibility
 */
export type ReviewType = "product-market-fit" | "technical-feasibility";

/**
 * Proposal status values
 */
export type ProposalStatus = "proposed" | "approved" | "rejected" | "in-review";

/**
 * A review from PM or Architect
 */
export interface ProposalReview {
	id: string;
	proposalId: string;
	reviewer: string;
	type: ReviewType;
	approved: boolean;
	score: number; // 1-10
	comments: string;
	reviewedAt: string;
}

/**
 * A proposal for a potential proposal
 */
export interface Proposal {
	id: string;
	proposalId: string;
	title: string;
	description: string;
	research: string;
	submittedBy: string;
	status: ProposalStatus;
	reviews: ProposalReview[];
	submittedAt: string;
	approvedAt?: string;
	approvedBy?: string;
}

/**
 * Result of a proposal claim attempt
 */
export interface ClaimResult {
	success: boolean;
	proposalId: string;
	claimedBy: string;
	message: string;
}

/**
 * Storage for proposals
 */
const proposals: Map<string, Proposal> = new Map();
const reviews: Map<string, ProposalReview> = new Map();

/**
 * Generate a unique ID
 */
function generateId(prefix: string): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 8);
	return `${prefix}-${timestamp}-${random}`;
}

/**
 * Load proposals from file
 */
export function loadProposals(filePath: string): void {
	if (!existsSync(filePath)) {
		return;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const data = JSON.parse(content);

		if (data.proposals) {
			for (const p of data.proposals) {
				proposals.set(p.id, p);
			}
		}

		if (data.reviews) {
			for (const r of data.reviews) {
				reviews.set(r.id, r);
			}
		}
	} catch {
		// Ignore parse errors
	}
}

/**
 * Save proposals to file
 */
export function saveProposals(filePath: string): void {
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const data = {
		proposals: Array.from(proposals.values()),
		reviews: Array.from(reviews.values()),
	};

	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Submit a new proposal from a New proposal
 * AC#1: New components can be promoted to 'Proposed' status with research document
 */
export function submitProposal(
	proposalId: string,
	options: {
		title: string;
		description: string;
		research: string;
		submittedBy: string;
	},
): Proposal {
	// Check if proposal already exists for this proposal
	const existing = getProposalByProposalId(proposalId);
	if (existing) {
		throw new Error(
			`Proposal already exists for ${proposalId}: ${existing.id}`,
		);
	}

	const proposal: Proposal = {
		id: generateId("PROP"),
		proposalId,
		title: options.title,
		description: options.description,
		research: options.research,
		submittedBy: options.submittedBy,
		status: "proposed",
		reviews: [],
		submittedAt: new Date().toISOString(),
	};

	proposals.set(proposal.id, proposal);
	return proposal;
}

/**
 * Get proposal by ID
 */
export function getProposal(id: string): Proposal | undefined {
	return proposals.get(id);
}

/**
 * Get proposal by proposal ID
 */
export function getProposalByProposalId(
	proposalId: string,
): Proposal | undefined {
	return Array.from(proposals.values()).find(
		(p) => p.proposalId === proposalId,
	);
}

/**
 * Add a review to a proposal
 * AC#2: Product Manager reviews for product-market fit
 * AC#3: Architect reviews for technical feasibility
 */
export function addReview(
	proposalId: string,
	options: {
		reviewer: string;
		type: ReviewType;
		approved: boolean;
		score: number;
		comments: string;
	},
): ProposalReview {
	const proposal = proposals.get(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	if (proposal.status !== "proposed") {
		throw new Error(`Cannot review proposal in status: ${proposal.status}`);
	}

	// Check if reviewer already reviewed for this type
	const existingReview = proposal.reviews.find((r) => r.type === options.type);
	if (existingReview) {
		throw new Error(`Review already exists for type: ${options.type}`);
	}

	const review: ProposalReview = {
		id: generateId("REV"),
		proposalId,
		reviewer: options.reviewer,
		type: options.type,
		approved: options.approved,
		score: Math.max(1, Math.min(10, options.score)),
		comments: options.comments,
		reviewedAt: new Date().toISOString(),
	};

	reviews.set(review.id, review);
	proposal.reviews.push(review);

	// Auto-approve if both reviews are approved
	autoApproveIfNeeded(proposal);

	return review;
}

/**
 * Auto-approve proposal if both reviews pass
 * AC#4: Both PM + Architect approval required before 'Approved' status
 */
function autoApproveIfNeeded(proposal: Proposal): void {
	const pmReview = proposal.reviews.find(
		(r) => r.type === "product-market-fit",
	);
	const archReview = proposal.reviews.find(
		(r) => r.type === "technical-feasibility",
	);

	if (pmReview && archReview && pmReview.approved && archReview.approved) {
		proposal.status = "approved";
		proposal.approvedAt = new Date().toISOString();
	}
}

/**
 * Manually approve a proposal (overrides auto-approval)
 */
export function approveProposal(
	proposalId: string,
	approvedBy: string = "system",
): Proposal {
	const proposal = proposals.get(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	if (proposal.status !== "proposed") {
		throw new Error(`Cannot approve proposal in status: ${proposal.status}`);
	}

	proposal.status = "approved";
	proposal.approvedAt = new Date().toISOString();
	proposal.approvedBy = approvedBy;

	return proposal;
}

/**
 * Reject a proposal
 */
export function rejectProposal(proposalId: string, reason: string): Proposal {
	const proposal = proposals.get(proposalId);
	if (!proposal) {
		throw new Error(`Proposal not found: ${proposalId}`);
	}

	if (proposal.status !== "proposed") {
		throw new Error(`Cannot reject proposal in status: ${proposal.status}`);
	}

	proposal.status = "rejected";
	proposal.reviews.push({
		id: generateId("REV"),
		proposalId,
		reviewer: "system",
		type: "product-market-fit",
		approved: false,
		score: 0,
		comments: reason,
		reviewedAt: new Date().toISOString(),
	});

	return proposal;
}

/**
 * Get proposals by status
 */
export function getProposalsByStatus(status: ProposalStatus): Proposal[] {
	return Array.from(proposals.values()).filter((p) => p.status === status);
}

/**
 * Claim an approved proposal for Active work
 * AC#5: Only Approved components can be claimed for Active work
 */
export function claimApprovedProposal(
	proposalId: string,
	claimedBy: string,
): ClaimResult {
	const proposal = getProposalByProposalId(proposalId);

	if (!proposal) {
		return {
			success: false,
			proposalId,
			claimedBy,
			message: `No proposal found for ${proposalId}. Must submit proposal first.`,
		};
	}

	if (proposal.status !== "approved") {
		return {
			success: false,
			proposalId,
			claimedBy,
			message: `Proposal ${proposalId} proposal is not approved (status: ${proposal.status}). Need both PM and Architect approval.`,
		};
	}

	return {
		success: true,
		proposalId,
		claimedBy,
		message: `Proposal ${proposalId} approved and ready for claiming by ${claimedBy}`,
	};
}

/**
 * Check if a proposal can be claimed
 */
export function canClaimProposal(proposalId: string): boolean {
	const result = claimApprovedProposal(proposalId, "check");
	return result.success;
}

/**
 * Get all proposals
 */
export function getAllProposals(): Proposal[] {
	return Array.from(proposals.values());
}

/**
 * Generate research document template
 */
export function generateProposalTemplate(
	proposalId: string,
	title: string,
): string {
	return `# Proposal: ${title}

## Proposal Reference
- **Proposal ID**: ${proposalId}
- **Title**: ${title}
- **Submitted By**: [Your Name]
- **Date**: ${new Date().toISOString().split("T")[0]}

## Executive Summary
[2-3 sentence overview of what this component does and why it's needed]

## Problem Proposalment
[What problem does this solve? Who has this problem?]

## Proposed Solution
[Detailed description of the proposed implementation]

## Technical Approach
- **Architecture**: [High-level architecture decisions]
- **Dependencies**: [What existing components this depends on]
- **Risks**: [Technical risks and mitigation strategies]
- **Effort Estimate**: [Rough estimate: XS/S/M/L/XL]

## Product-Market Fit
- **Target Users**: [Who benefits from this?]
- **Business Value**: [What's the business impact?]
- **Success Metrics**: [How do we measure success?]
- **Alternatives Considered**: [Other solutions considered]

## Acceptance Criteria
[Draft acceptance criteria - these may be refined during implementation]
- [ ] AC#1: [First acceptance criterion]
- [ ] AC#2: [Second acceptance criterion]
- [ ] AC#3: [Third acceptance criterion]

## Research & References
- [Link to related research or similar implementations]
- [Link to user feedback or feature requests]
- [Link to technical documentation]

## Open Questions
- [Question 1 that needs investigation]
- [Question 2 that needs investigation]
`;
}

/**
 * Reset all proposals and reviews (for testing)
 */
export function resetProposals(): void {
	proposals.clear();
	reviews.clear();
}

/**
 * Check if a review exists for a proposal and type
 */
export function hasReviewType(proposalId: string, type: ReviewType): boolean {
	const proposal = proposals.get(proposalId);
	if (!proposal) return false;
	return proposal.reviews.some((r) => r.type === type);
}

/**
 * Get reviews for a proposal
 */
export function getProposalReviews(proposalId: string): ProposalReview[] {
	const proposal = proposals.get(proposalId);
	return proposal ? proposal.reviews : [];
}

/**
 * Get proposal status summary
 */
export function getProposalSummary(): {
	proposed: number;
	approved: number;
	rejected: number;
	total: number;
} {
	const all = Array.from(proposals.values());
	return {
		proposed: all.filter((p) => p.status === "proposed").length,
		approved: all.filter((p) => p.status === "approved").length,
		rejected: all.filter((p) => p.status === "rejected").length,
		total: all.length,
	};
}
