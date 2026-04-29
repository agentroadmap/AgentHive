/**
 * S104: Agent Activity Monitoring & Anomaly Detection
 *
 * Monitors agent behavior for:
 * - Runaway proposal creation (>10/hour)
 * - Duplicate proposals (>3 similar in 1 hour)
 * - Proposal count threshold (warn >150, stop >200)
 *
 * Created: 2026-03-30 by Andy (during GQ77 badminton)
 */

export interface AgentEvent {
	agent_id: string;
	action: "create" | "update" | "delete";
	proposal_id: string;
	timestamp: number;
}

export interface AnomalyAlert {
	type: "rate_limit" | "duplicate" | "proposal_count";
	agent_id?: string;
	message: string;
	severity: "warn" | "critical";
}

// AC#1: Proposal count monitor
export function checkProposalCount(
	totalProposals: number,
): AnomalyAlert | null {
	if (totalProposals > 200) {
		return {
			type: "proposal_count",
			message: `Critical: ${totalProposals} proposals exceeds 200 limit`,
			severity: "critical",
		};
	}
	if (totalProposals > 150) {
		return {
			type: "proposal_count",
			message: `Warning: ${totalProposals} proposals exceeds 150 threshold`,
			severity: "warn",
		};
	}
	return null;
}

// AC#2: Rate limiter
export function checkRateLimit(
	events: AgentEvent[],
	agentId: string,
): AnomalyAlert | null {
	const oneHourAgo = Date.now() - 3600000;
	const recentCreates = events.filter(
		(e) =>
			e.agent_id === agentId &&
			e.action === "create" &&
			e.timestamp > oneHourAgo,
	);

	if (recentCreates.length > 10) {
		return {
			type: "rate_limit",
			agent_id: agentId,
			message: `Agent ${agentId} created ${recentCreates.length} proposals in 1 hour (limit: 10)`,
			severity: "critical",
		};
	}
	return null;
}

// AC#3: Duplication detector
export function checkDuplicates(
	proposals: Array<{ title: string; created_at: number }>,
	agentId: string,
): AnomalyAlert | null {
	const oneHourAgo = Date.now() - 3600000;
	const agentProposals = proposals.filter((s) => s.created_at > oneHourAgo);

	// Simple fuzzy match - check for similar titles
	const titles = agentProposals.map((s) => s.title.toLowerCase());
	const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);

	if (duplicates.length >= 2) {
		return {
			type: "duplicate",
			agent_id: agentId,
			message: `Agent ${agentId} has ${duplicates.length} duplicate titles in 1 hour`,
			severity: "critical",
		};
	}
	return null;
}

export {
	checkProposalCount as AC1,
	checkRateLimit as AC2,
	checkDuplicates as AC3,
};
