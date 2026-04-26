/**
 * P224 AC-6: Stale lease cleanup
 *
 * Periodically releases leases that have expired and are older than 10 minutes.
 * This prevents blocking when an agent crashes or loses connectivity.
 */

import { query } from "../../infra/postgres/pool.ts";

const STALE_LEASE_MINUTES = 10;

/**
 * Release leases that have:
 * 1. expires_at < NOW() (actually expired)
 * 2. claimed_at < NOW() - 10 minutes (older than threshold)
 *
 * Returns the count of leases released.
 */
export async function cleanupStaleLeasesIfNeeded(): Promise<number> {
	const staleThreshold = new Date(Date.now() - STALE_LEASE_MINUTES * 60 * 1000);

	const { rowCount } = await query(
		`UPDATE roadmap_proposal.proposal_lease
     SET released_at = NOW(),
         release_reason = 'auto-released: stale lease (P224 AC-6)'
     WHERE released_at IS NULL
       AND expires_at < NOW()
       AND claimed_at < $1`,
		[staleThreshold],
	);

	return rowCount;
}

/**
 * Manual administrative cleanup: release all expired leases regardless of age.
 * Use only for emergency situations or manual intervention.
 */
export async function forceCleanupExpiredLeases(): Promise<number> {
	const { rowCount } = await query(
		`UPDATE roadmap_proposal.proposal_lease
     SET released_at = NOW(),
         release_reason = 'force-released: admin cleanup (P224 AC-6)'
     WHERE released_at IS NULL
       AND expires_at < NOW()`,
	);

	return rowCount;
}

/**
 * Also clean up stale processing entries in transition_queue.
 * Processing entries older than 10 minutes that haven't completed should be reset to pending.
 * This allows another agent to try processing them.
 */
export async function cleanupStaleTransitionProcessing(): Promise<number> {
	const staleThreshold = new Date(Date.now() - STALE_LEASE_MINUTES * 60 * 1000);

	const { rowCount } = await query(
		`UPDATE roadmap_proposal.transition_queue
     SET status = 'pending',
         claimed_by = NULL,
         processing_started_at = NULL,
         failure_reason = 'reset: stale processing (P224 AC-6)'
     WHERE status = 'processing'
       AND processing_started_at < $1`,
		[staleThreshold],
	);

	return rowCount;
}
