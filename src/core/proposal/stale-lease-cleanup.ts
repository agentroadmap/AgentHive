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

	// P934: legacy 'auto-released: stale lease (P224 AC-6)' replaced with
	// canonical 'lease_expired'. Trigger maps to incomplete bucket → maturity='new'.
	// Original P224 AC-6 context preserved in this code comment, not in the
	// release_reason column (which is now a short canonical enum).
	const { rowCount } = await query(
		`UPDATE roadmap_proposal.proposal_lease
     SET released_at = NOW(),
         release_reason = 'lease_expired'
     WHERE released_at IS NULL
       AND expires_at < NOW()
       AND claimed_at < $1`,
		[staleThreshold],
	);

	return rowCount ?? 0;
}

/**
 * Manual administrative cleanup: release all expired leases regardless of age.
 * Use only for emergency situations or manual intervention.
 */
export async function forceCleanupExpiredLeases(): Promise<number> {
	// P934: legacy 'force-released: admin cleanup (P224 AC-6)' replaced
	// with canonical 'force_reclaimed'. Maps to incomplete bucket → maturity='new'.
	const { rowCount } = await query(
		`UPDATE roadmap_proposal.proposal_lease
     SET released_at = NOW(),
         release_reason = 'force_reclaimed'
     WHERE released_at IS NULL
       AND expires_at < NOW()`,
	);

	return rowCount ?? 0;
}

