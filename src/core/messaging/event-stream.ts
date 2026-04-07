/**
 * Lightweight in-process event stream for board activity.
 *
 * Events are kept in memory so UI components can render recent activity
 * without depending on any external database runtime.
 */

/** Event types for proposal lifecycle */
export type EventType =
	| "proposal_accepted"
	| "proposal_claimed"
	| "proposal_coding"
	| "review_requested"
	| "proposal_reviewing"
	| "review_passed"
	| "review_failed"
	| "proposal_complete"
	| "proposal_merged"
	| "proposal_pushed"
	| "agent_online"
	| "agent_offline"
	| "message"
	| "cubic_phase_change"
	| "handoff"
	| "heartbeat"
	| "custom";

/** A stream event */
export interface StreamEvent {
	id: string;
	type: EventType;
	timestamp: number;
	proposalId?: string;
	agentId?: string;
	message: string;
	metadata: Record<string, string>;
}

const memoryEvents: StreamEvent[] = [];

/**
 * Insert an event into the in-process event stream.
 */
export function insertEvent(
	type: EventType,
	proposalId: string | undefined,
	agentId: string | undefined,
	message: string,
	metadata: Record<string, string> = {},
): boolean {
	memoryEvents.push({
		id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		type,
		timestamp: Date.now(),
		proposalId,
		agentId,
		message,
		metadata,
	});

	if (memoryEvents.length > 500) {
		memoryEvents.splice(0, memoryEvents.length - 500);
	}

	return true;
}

/**
 * Get recent events from the in-process buffer.
 */
export function getRecentEvents(limit = 50): StreamEvent[] {
	return memoryEvents.slice(-limit).reverse();
}

export function emitProposalAccepted(proposalId: string, title: string): void {
	insertEvent(
		"proposal_accepted",
		proposalId,
		undefined,
		`${proposalId} is accepted`,
		{ title },
	);
}

export function emitProposalClaimed(
	proposalId: string,
	agentId: string,
	agentName: string,
): void {
	insertEvent(
		"proposal_claimed",
		proposalId,
		agentId,
		`${proposalId} claimed by ${agentName}`,
		{ agentName },
	);
}

export function emitCodingStarted(proposalId: string, agentId: string): void {
	insertEvent(
		"proposal_coding",
		proposalId,
		agentId,
		`${proposalId} coding started`,
	);
}

export function emitReviewRequested(
	proposalId: string,
	fromAgent: string,
	toAgent: string,
): void {
	insertEvent(
		"review_requested",
		proposalId,
		fromAgent,
		`${proposalId} review requested by ${fromAgent}`,
		{ reviewer: toAgent },
	);
}

export function emitReviewing(
	proposalId: string,
	reviewerId: string,
	reviewerName: string,
): void {
	insertEvent(
		"proposal_reviewing",
		proposalId,
		reviewerId,
		`${proposalId} being reviewed by ${reviewerName}`,
		{ reviewerName },
	);
}

export function emitReviewPassed(proposalId: string, reviewerId: string): void {
	insertEvent(
		"review_passed",
		proposalId,
		reviewerId,
		`${proposalId} review passed`,
	);
}

export function emitReviewFailed(
	proposalId: string,
	reviewerId: string,
	reason: string,
): void {
	insertEvent(
		"review_failed",
		proposalId,
		reviewerId,
		`${proposalId} review failed: ${reason}`,
		{ reason },
	);
}

export function emitProposalComplete(
	proposalId: string,
	agentId: string,
): void {
	insertEvent(
		"proposal_complete",
		proposalId,
		agentId,
		`${proposalId} is complete`,
	);
}

export function emitMergedToMain(proposalId: string): void {
	insertEvent(
		"proposal_merged",
		proposalId,
		undefined,
		`${proposalId} merged to local main`,
	);
}

export function emitPushedToGitLab(proposalId: string): void {
	insertEvent(
		"proposal_pushed",
		proposalId,
		undefined,
		`${proposalId} pushed to remote`,
	);
}

export function emitAgentOnline(agentId: string, agentName: string): void {
	insertEvent("agent_online", undefined, agentId, `${agentName} is online`, {
		agentName,
	});
}

export function emitAgentOffline(agentId: string, agentName: string): void {
	insertEvent(
		"agent_offline",
		undefined,
		agentId,
		`${agentName} went offline`,
		{ agentName },
	);
}

export function emitHandoff(
	proposalId: string,
	fromPhase: string,
	toPhase: string,
	agentId: string,
): void {
	insertEvent(
		"handoff",
		proposalId,
		agentId,
		`${proposalId} handed off: ${fromPhase} → ${toPhase}`,
		{ fromPhase, toPhase },
	);
}

export function emitMessage(
	fromAgent: string,
	channel: string,
	preview: string,
): void {
	insertEvent("message", undefined, fromAgent, preview, { channel });
}

export function emitCubicPhaseChange(
	cubicId: string,
	fromPhase: string,
	toPhase: string,
): void {
	insertEvent(
		"cubic_phase_change",
		undefined,
		undefined,
		`Cubic ${cubicId}: ${fromPhase} → ${toPhase}`,
		{
			cubicId,
			fromPhase,
			toPhase,
		},
	);
}
