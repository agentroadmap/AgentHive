/**
 * P1106 F5: DLQ Replay — re-deliver messages from dead_letter_queue.
 *
 * Security constraint (AC-15): dlqReplay() MUST check sig_verified on the
 * original message_ledger row before re-delivery. Messages with sig_verified
 * values other than 'verified' are logged and skipped — never re-sent.
 *
 * F7 (P1106): All queries use canonical schema-qualified table names:
 *   roadmap.dead_letter_queue, roadmap.message_ledger
 */

import type { Pool } from "pg";

/** A row fetched from roadmap.dead_letter_queue for replay. */
export interface DLQEntry {
	id: string;
	original_message_id: string | null;
	from_agent: string;
	to_agent: string | null;
	channel: string | null;
	payload: string | null;
	failure_reason: string;
	retry_budget_used: number;
	dead_at: string;
	replayed_at: string | null;
	replay_succeeded: boolean | null;
}

/** Result of a single DLQ replay attempt. */
export interface ReplayResult {
	dlqId: string;
	outcome: "skipped_sig" | "skipped_no_msg" | "success" | "error";
	reason?: string;
}

/**
 * Inspect unreplayed DLQ entries.
 * Returns up to `limit` entries ordered by dead_at ascending.
 */
export async function dlqInspect(pool: Pool, limit = 50): Promise<DLQEntry[]> {
	const { rows } = await pool.query<DLQEntry>(
		`SELECT id, original_message_id, from_agent, to_agent, channel,
		        payload, failure_reason, retry_budget_used, dead_at,
		        replayed_at, replay_succeeded
		 FROM roadmap.dead_letter_queue
		 WHERE replayed_at IS NULL
		 ORDER BY dead_at ASC
		 LIMIT $1`,
		[limit],
	);
	return rows;
}

/**
 * Attempt to replay a single DLQ entry.
 *
 * AC-15: sig_verified='verified' is required on the original message_ledger row.
 * Any other status ('pending', 'failed') causes the entry to be logged and skipped;
 * no delivery is attempted. This prevents re-injection of unverified messages.
 *
 * On a successful re-delivery (pg_notify sent), updates replayed_at and
 * replay_succeeded=true on the DLQ row. On delivery error, updates replay_succeeded=false.
 *
 * @param pool - Postgres connection pool
 * @param dlqId - Primary key of the roadmap.dead_letter_queue row to replay
 * @param notifyFn - Callback that performs actual delivery (pg_notify or HTTP relay).
 *   Called only when sig_verified='verified'. Must throw on failure.
 */
export async function dlqReplay(
	pool: Pool,
	dlqId: string,
	notifyFn: (entry: DLQEntry) => Promise<void>,
): Promise<ReplayResult> {
	// Fetch the DLQ entry (F7: canonical table name)
	const { rows: dlqRows } = await pool.query<DLQEntry>(
		`SELECT id, original_message_id, from_agent, to_agent, channel,
		        payload, failure_reason, retry_budget_used, dead_at,
		        replayed_at, replay_succeeded
		 FROM roadmap.dead_letter_queue
		 WHERE id = $1`,
		[dlqId],
	);

	if (dlqRows.length === 0) {
		return { dlqId, outcome: "error", reason: "DLQ entry not found" };
	}

	const entry = dlqRows[0];

	// AC-15 (F5): Verify sig_verified on the original message_ledger row.
	// If original_message_id is null (e.g., message already pruned), treat as unverified.
	if (!entry.original_message_id) {
		console.warn(
			`[DLQReplay] dlq=${dlqId}: original_message_id is null — skipping (cannot verify signature)`,
		);
		await markReplayOutcome(pool, dlqId, false);
		return { dlqId, outcome: "skipped_no_msg", reason: "original_message_id is null" };
	}

	const { rows: ledgerRows } = await pool.query<{ sig_verified: string }>(
		// F7: use roadmap.message_ledger (not alias)
		`SELECT sig_verified FROM roadmap.message_ledger WHERE id = $1`,
		[entry.original_message_id],
	);

	if (ledgerRows.length === 0) {
		console.warn(
			`[DLQReplay] dlq=${dlqId}: original message ${entry.original_message_id} not found in roadmap.message_ledger`,
		);
		await markReplayOutcome(pool, dlqId, false);
		return { dlqId, outcome: "skipped_no_msg", reason: "original message not found" };
	}

	const { sig_verified } = ledgerRows[0];
	if (sig_verified !== "verified") {
		// Reject — unverified or failed signatures MUST NOT be re-delivered
		console.warn(
			`[DLQReplay] dlq=${dlqId}: sig_verified='${sig_verified}' — refusing replay (AC-15)`,
		);
		await markReplayOutcome(pool, dlqId, false);
		return {
			dlqId,
			outcome: "skipped_sig",
			reason: `sig_verified='${sig_verified}'; only 'verified' messages are replayed`,
		};
	}

	// Signature is verified — attempt delivery
	try {
		await notifyFn(entry);
		await markReplayOutcome(pool, dlqId, true);
		console.log(`[DLQReplay] dlq=${dlqId}: replay succeeded`);
		return { dlqId, outcome: "success" };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[DLQReplay] dlq=${dlqId}: delivery error — ${reason}`);
		await markReplayOutcome(pool, dlqId, false);
		return { dlqId, outcome: "error", reason };
	}
}

/** Persist the replay outcome on the DLQ row. */
async function markReplayOutcome(
	pool: Pool,
	dlqId: string,
	succeeded: boolean,
): Promise<void> {
	try {
		await pool.query(
			// F7: canonical table reference
			`UPDATE roadmap.dead_letter_queue
			 SET replayed_at = now(), replay_succeeded = $1
			 WHERE id = $2`,
			[succeeded, dlqId],
		);
	} catch (err) {
		console.error(
			`[DLQReplay] Failed to update replay outcome for dlq=${dlqId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
