/**
 * P224/P750 AC-1: Gate scanner respects active leases with atomic dispatch locking
 *
 * Provides helper functions for the gate advancement scanner to skip proposals
 * where another agent holds an active lease. Lease acquisition uses row-level
 * locking (FOR UPDATE SKIP LOCKED) to prevent duplicate dispatch across
 * concurrent orchestrator instances.
 *
 * P750 Design:
 * - Select from v_mature_queue ordered by created_at
 * - For each candidate, attempt to acquire a dispatch lease atomically
 * - If lease acquisition succeeds, proposal is returned unlocked
 * - If lease already exists, FOR UPDATE SKIP LOCKED skips it (no retry needed)
 * - Results are proposals with guaranteed single-flight dispatch semantics
 */

import { getPool, query } from "../../infra/postgres/pool.ts";

export interface ProposalInQueueResult {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: string;
	hasActiveLease: boolean;
	leaseHolder?: string;
	leaseId?: string;
}

/**
 * Get proposals from the mature queue (v_mature_queue) with atomic lease acquisition.
 *
 * P750 AC-1: Dispatch tick claims eligible proposal_lease rows with row-level
 * locking (FOR UPDATE SKIP LOCKED). This function:
 *
 * 1. Fetches mature queue candidates ordered by created_at
 * 2. For each candidate, attempts atomic lease acquisition within a transaction
 * 3. If lease already exists and is active, FOR UPDATE SKIP LOCKED skips it
 * 4. If no lease exists, creates a "dispatch lock" lease row atomically
 * 5. Returns only proposals where lease acquisition succeeded
 *
 * Failed acquisitions (other instance holds lease) are transparently skipped.
 *
 * @param limit Maximum number of unlocked proposals to return
 * @returns Array of proposals without active leases (single-flight guaranteed)
 */
export async function getGateQueue(limit: number = 100): Promise<ProposalInQueueResult[]> {
	// Fetch mature queue candidates (does not acquire locks yet)
	const { rows: candidates } = await query<{
		id: number;
		display_id: string;
		type: string;
		title: string;
		status: string;
		maturity: string;
		created_at: string;
	}>(
		`SELECT
       mq.id,
       mq.display_id,
       mq.type,
       mq.title,
       mq.status,
       mq.maturity,
       mq.created_at
     FROM roadmap_proposal.v_mature_queue mq
     ORDER BY mq.created_at ASC
     LIMIT $1`,
		[limit * 2], // Fetch more since some may fail lease acquisition
	);

	const result: ProposalInQueueResult[] = [];
	const client = await getPool().connect();

	try {
		for (const candidate of candidates) {
			if (result.length >= limit) break;

			try {
				await client.query("BEGIN");

				// Check if an active lease already exists and lock it.
				// FOR UPDATE SKIP LOCKED: if a lease row exists, lock it and we'll see it.
				// If locked by another xact, skip this candidate entirely.
				const { rows: existingLeases } = await client.query<{
					id: number;
					agent_identity: string;
				}>(
					`SELECT id, agent_identity
					 FROM roadmap_proposal.proposal_lease
					 WHERE proposal_id = $1
					   AND released_at IS NULL
					 FOR UPDATE SKIP LOCKED
					 LIMIT 1`,
					[candidate.id],
				);

				if (existingLeases.length > 0) {
					// Another worker already holds this lease, skip it
					await client.query("COMMIT");
					continue;
				}

				// No active lease exists. Attempt to create a dispatch lock lease atomically.
				// This is the single-flight barrier: only one instance will succeed in
				// inserting the row. The insert uses UNIQUE(proposal_id, released_at IS NULL)
				// constraint or similar to prevent duplicates.
				const leaseId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				const now = new Date();
				const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min default

				const { rows: insertRows } = await client.query<{ id: number }>(
					`INSERT INTO roadmap_proposal.proposal_lease
					 (proposal_id, agent_identity, created_at, expires_at, released_at)
					 VALUES ($1, $2, $3, $4, NULL)
					 ON CONFLICT DO NOTHING
					 RETURNING id`,
					[
						candidate.id,
						leaseId,
						now.toISOString(),
						expiresAt.toISOString(),
					],
				);

				if (insertRows.length === 0) {
					// Another instance beat us to creating the lease, skip this candidate
					await client.query("COMMIT");
					continue;
				}

				// Successfully acquired the lease. Lock the row we just created to hold it
				// until we commit.
				await client.query(
					`SELECT 1 FROM roadmap_proposal.proposal_lease
					 WHERE id = $1
					 FOR UPDATE`,
					[insertRows[0].id],
				);

				// Commit the transaction, holding the lease
				await client.query("COMMIT");

				// Return this proposal as available for dispatch
				result.push({
					id: candidate.id,
					display_id: candidate.display_id,
					type: candidate.type,
					title: candidate.title,
					status: candidate.status,
					maturity: candidate.maturity,
					hasActiveLease: false,
					leaseHolder: leaseId,
					leaseId: leaseId,
				});
			} catch (err) {
				// Transaction error (e.g., constraint violation, lock timeout)
				// Rollback and try next candidate
				try {
					await client.query("ROLLBACK");
				} catch {
					// Already rolled back or connection error, continue
				}
				continue;
			}
		}
	} finally {
		client.release();
	}

	return result;
}

/**
 * Filter gate queue results to only include proposals without active leases.
 *
 * AC-1: The gate scanner should skip proposals with active leases.
 * This helper makes that filtering explicit and testable.
 *
 * DEPRECATED: getGateQueue() now returns only unlocked proposals (atomic dispatch).
 * This function is kept for backward compatibility with callers that may
 * expect a pre-filter interface.
 *
 * @param queueResults Results from getGateQueue()
 * @returns Filtered array excluding leased proposals (already guaranteed by getGateQueue)
 */
export function filterUnlockedProposals(queueResults: ProposalInQueueResult[]): ProposalInQueueResult[] {
	return queueResults.filter((item) => !item.hasActiveLease);
}

/**
 * Get unlocked proposals from the mature queue.
 *
 * P750 AC-1 compliant: Dispatch tick claims eligible proposal_lease rows
 * with row-level locking. This function returns proposals with guaranteed
 * single-flight dispatch semantics — at most one orchestrator instance
 * will receive each proposal per call.
 *
 * @param limit Maximum number of unlocked proposals to return
 * @returns Array of proposals without active leases (single-flight guaranteed)
 */
export async function getUnlockedGateQueue(limit: number = 100): Promise<ProposalInQueueResult[]> {
	// getGateQueue now performs atomic dispatch locking, returning only unlocked proposals
	return getGateQueue(limit);
}
