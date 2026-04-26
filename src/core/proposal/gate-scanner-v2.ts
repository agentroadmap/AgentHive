/**
 * P224 AC-1: Gate scanner respects active leases
 *
 * Provides helper functions for the gate advancement scanner to skip proposals
 * where another agent holds an active lease. This prevents duplicate gating
 * when multiple agents or processes might try to advance the same proposal.
 */

import { query } from "../../infra/postgres/pool.ts";

export interface ProposalInQueueResult {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: string;
	hasActiveLease: boolean;
	leaseHolder?: string;
}

/**
 * Get proposals from the mature queue (v_mature_queue) with lease information.
 *
 * AC-1: Gate scanner should skip proposals where another agent holds an active lease.
 * This function returns the lease status so the scanner can decide whether to process.
 *
 * @param limit Maximum number of proposals to return
 * @returns Array of proposals with lease status
 */
export async function getGateQueue(limit: number = 100): Promise<ProposalInQueueResult[]> {
	const { rows } = await query<{
		id: number;
		display_id: string;
		type: string;
		title: string;
		status: string;
		maturity: string;
		agent_identity?: string;
	}>(
		`SELECT
       mq.id,
       mq.display_id,
       mq.type,
       mq.title,
       mq.status,
       mq.maturity,
       pl.agent_identity
     FROM roadmap_proposal.v_mature_queue mq
     LEFT JOIN (
       SELECT DISTINCT proposal_id, agent_identity
       FROM roadmap_proposal.proposal_lease
       WHERE released_at IS NULL
     ) pl ON pl.proposal_id = mq.id
     ORDER BY mq.created_at ASC
     LIMIT $1`,
		[limit],
	);

	return rows.map((row) => ({
		id: row.id,
		display_id: row.display_id,
		type: row.type,
		title: row.title,
		status: row.status,
		maturity: row.maturity,
		hasActiveLease: !!row.agent_identity,
		leaseHolder: row.agent_identity,
	}));
}

/**
 * Filter gate queue results to only include proposals without active leases.
 *
 * AC-1: The gate scanner should skip proposals with active leases.
 * This helper makes that filtering explicit and testable.
 *
 * @param queueResults Results from getGateQueue()
 * @returns Filtered array excluding leased proposals
 */
export function filterUnlockedProposals(queueResults: ProposalInQueueResult[]): ProposalInQueueResult[] {
	return queueResults.filter((item) => !item.hasActiveLease);
}

/**
 * Single call to get unlocked proposals from the mature queue.
 * Combines getGateQueue + filterUnlockedProposals for convenience.
 *
 * @param limit Maximum number of unlocked proposals to return
 * @returns Array of proposals without active leases
 */
export async function getUnlockedGateQueue(limit: number = 100): Promise<ProposalInQueueResult[]> {
	const all = await getGateQueue(limit * 2); // Fetch more to account for locked proposals
	return filterUnlockedProposals(all).slice(0, limit);
}
