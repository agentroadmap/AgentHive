/**
 * S131: Proposal Promotion Metadata, Audit Trail & Voting Gates
 *
 * Tables: promotion_history, gate_vote
 * Voting gates for each transition
 *
 * Created: 2026-03-30 by Andy
 */

export type Vote = "approve" | "reject";
export type Transition =
	| "Proposal→Draft"
	| "Draft→Accepted"
	| "Accepted→Active"
	| "Active→Review"
	| "Review→Complete";

export interface PromotionHistory {
	id?: number;
	proposal_id: string;
	from_status: string;
	to_status: string;
	promoted_by: string;
	promoted_at: number;
	reason: string;
	missing_before: string; // JSON array
}

export interface GateVote {
	id?: number;
	proposal_id: string;
	voter_id: string;
	vote: Vote;
	comment: string;
	voted_at: number;
	expires_at: number;
}

// AC#1: Promotion metadata
export function createPromotionRecord(
	proposalId: string,
	fromStatus: string,
	toStatus: string,
	agentId: string,
	reason: string,
	missingBefore: string[],
): PromotionHistory {
	return {
		proposal_id: proposalId,
		from_status: fromStatus,
		to_status: toStatus,
		promoted_by: agentId,
		promoted_at: Date.now(),
		reason,
		missing_before: JSON.stringify(missingBefore),
	};
}

// AC#2: Voting gates
export const VOTING_GATES: Record<
	Transition,
	{ required: number; voterRole: string; selfVote: boolean }
> = {
	"Proposal→Draft": { required: 1, voterRole: "reviewer", selfVote: false },
	"Draft→Accepted": { required: 1, voterRole: "pm", selfVote: false },
	"Accepted→Active": { required: 0, voterRole: "assignee", selfVote: true }, // self-claim
	"Active→Review": { required: 0, voterRole: "implementer", selfVote: true }, // self-submit
	"Review→Complete": {
		required: 2,
		voterRole: "reviewer+tester",
		selfVote: false,
	},
};

// AC#3: Vote validation (S119 - implementer cannot vote on own work)
export function validateVote(
	proposal: { implementer_id: string; proposal_id: string },
	vote: { voter_id: string; vote: Vote },
): { valid: boolean; reason?: string } {
	// S119: Implementer cannot approve own work
	if (proposal.implementer_id === vote.voter_id && vote.vote === "approve") {
		return {
			valid: false,
			reason: "Implementer cannot approve own work (S119)",
		};
	}
	return { valid: true };
}

// AC#4: Vote expiry check
export function isVoteExpired(vote: GateVote): boolean {
	return Date.now() > vote.expires_at;
}

// AC#5: Gate status
export function checkGateStatus(
	_proposalId: string,
	votes: GateVote[],
	transition: Transition,
): { passed: boolean; votesNeeded: number; votesReceived: number } {
	const gate = VOTING_GATES[transition];
	const validVotes = votes.filter(
		(v) => !isVoteExpired(v) && v.vote === "approve",
	);

	return {
		passed: validVotes.length >= gate.required,
		votesNeeded: gate.required,
		votesReceived: validVotes.length,
	};
}

export {
	createPromotionRecord as AC1,
	VOTING_GATES as AC2,
	validateVote as AC3,
	isVoteExpired as AC4,
	checkGateStatus as AC5,
};
