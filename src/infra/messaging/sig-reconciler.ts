/**
 * P1106-E F2: Signature reconciler for roadmap.message_ledger.
 *
 * Scans for sig_verified='pending' rows older than PENDING_THRESHOLD_SECS (60s)
 * and marks them 'failed'. Uses pg_try_advisory_lock(11060001) so only one
 * replica runs the update per tick.
 */

import type { Pool } from "pg";

const PENDING_THRESHOLD_SECS = 60;
const RECONCILER_INTERVAL_MS = 30_000;
const ADVISORY_LOCK_KEY = 11060001;
const GLOBAL_KEY = "__sigReconcilerInterval";

export async function reconcilePendingSignatures(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		const lockResult = await client.query<{ acquired: boolean }>(
			`SELECT pg_try_advisory_lock($1) AS acquired`,
			[ADVISORY_LOCK_KEY],
		);
		if (!lockResult.rows[0]?.acquired) return;

		const result = await client.query<{ id: number }>(
			`UPDATE roadmap.message_ledger
			 SET sig_verified = 'failed'
			 WHERE sig_verified = 'pending'
			   AND created_at < now() - ($1 || ' seconds')::interval
			 RETURNING id`,
			[PENDING_THRESHOLD_SECS],
		);

		if ((result.rowCount ?? 0) > 0) {
			console.log(
				`[P1106/sig-reconciler] Marked ${result.rowCount} stale sig_verified='pending' rows as 'failed'`,
			);
		}
	} catch (err) {
		console.error("[P1106/sig-reconciler] Error during reconciliation:", err);
	} finally {
		// Releasing the client returns the advisory lock automatically.
		client.release();
	}
}

export function registerSigReconciler(pool: Pool): void {
	const g = globalThis as Record<string, unknown>;
	if (g[GLOBAL_KEY]) {
		console.log("[P1106/sig-reconciler] Already registered — skipping");
		return;
	}

	const interval = setInterval(() => {
		reconcilePendingSignatures(pool).catch((err) => {
			console.error(
				`[P1106/sig-reconciler] Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}, RECONCILER_INTERVAL_MS);

	g[GLOBAL_KEY] = interval;
	console.log(
		"[P1106/sig-reconciler] Registered (every 30s, advisory-lock guarded, marks pending→failed after 60s)",
	);
}
