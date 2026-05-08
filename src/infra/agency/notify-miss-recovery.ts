/**
 * Cursor-based recovery for missed liaison_message rows.
 *
 * P924 — Multi-host recovery and polling semantics.
 *
 * When a runtime's LISTEN connection drops or is on a different host from the
 * orchestrator, pg_notify messages may be lost. This module provides a polling
 * safety net: drainHostPendingMessages(hostId, sessionId, batchSize, onMessage)
 * claims and processes unacked liaison_message rows in a cursor-based (created_at, id)
 * order, ensuring no missed rows across partitions.
 *
 * Contract:
 * - Row lock via FOR UPDATE SKIP LOCKED prevents double-processing.
 * - acked_at is set ONLY after onMessage(row) succeeds (ok=true).
 * - Failed rows (ok=false) reappear in the next drain.
 * - Cursor bookkeeping (drain_cursor_created_at, drain_cursor_id) is advisory only;
 *   the drain query authority is WHERE acked_at IS NULL.
 */

import { query } from "../postgres/pool.ts";

/**
 * Shape of a liaison_message row returned by the drain query.
 */
export interface LiaisonMessageRow {
	message_id: string;
	agency_id: string;
	host_id: string | null;
	kind: string;
	direction: string;
	sequence: bigint;
	created_at: Date;
}

/**
 * Response from onMessage callback handler.
 */
export interface DrainMessageResult {
	ok: boolean;
	outcome?: string;
}

/**
 * Result of a complete drain operation.
 */
export interface DrainResult {
	drained: number;
	succeeded: number;
	failed: number;
}

/**
 * Cursor-based drain of pending messages for a specific host.
 *
 * Queries liaison_message with:
 *   - WHERE host_id = hostId AND acked_at IS NULL
 *   - ORDER BY created_at ASC, id ASC (composite cursor ordering per P922 AC-6)
 *   - LIMIT batchSize
 *   - FOR UPDATE SKIP LOCKED (row-level lock prevents double-processing)
 *
 * For each claimed row, calls onMessage(row). If ok=true, updates acked_at + ack_outcome.
 * If ok=false, row stays acked_at=NULL and reappears in the next drain.
 *
 * After each batch, updates session.metadata with (drain_cursor_created_at, drain_cursor_id)
 * for bookkeeping; this is advisory only (the query authority is acked_at IS NULL).
 *
 * @param hostId — AGENTHIVE_HOST_ID or similar; filters liaison_message.host_id
 * @param sessionId — agency_liaison_session.session_id; used to store cursor bookkeeping
 * @param batchSize — max rows per drain call (default 50)
 * @param onMessage — async handler; receives each claimed row, returns { ok, outcome? }
 * @returns { drained, succeeded, failed } counts
 */
export async function drainHostPendingMessages(
	hostId: string,
	sessionId: string,
	batchSize: number = 50,
	onMessage: (
		row: LiaisonMessageRow,
	) => Promise<DrainMessageResult>,
): Promise<DrainResult> {
	const results: DrainResult = { drained: 0, succeeded: 0, failed: 0 };

	try {
		// Claim unacked rows for this host, ordered (created_at, message_id) for cursor coherence.
		const claimResult = await query<LiaisonMessageRow>(
			`WITH claimed AS (
        SELECT message_id, agency_id, host_id, kind, direction, sequence, created_at
          FROM roadmap.liaison_message
         WHERE host_id = $1 AND acked_at IS NULL
         ORDER BY created_at ASC, message_id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      SELECT * FROM claimed`,
			[hostId, batchSize],
		);

		const rows = claimResult.rows;
		results.drained = rows.length;

		// Process each claimed row.
		let maxCreatedAt: Date | null = null;
		let maxMessageId: string | null = null;

		for (const row of rows) {
			try {
				const handlerResult = await onMessage(row);
				if (handlerResult.ok) {
					// Mark as acked with the outcome.
					await query(
						`UPDATE roadmap.liaison_message
           SET acked_at = now(), ack_outcome = COALESCE($1, 'ok')
           WHERE message_id = $2`,
						[handlerResult.outcome ?? "ok", row.message_id],
					);
					results.succeeded++;
					// Update cursor bookkeeping.
					maxCreatedAt = row.created_at;
					maxMessageId = row.message_id;
				} else {
					// Handler returned ok=false; row stays acked_at IS NULL.
					results.failed++;
				}
			} catch (err) {
				// Handler threw; row stays acked_at IS NULL (not acked).
				results.failed++;
			}
		}

		// Store cursor bookkeeping (advisory; next drain uses acked_at IS NULL authority).
		if (maxCreatedAt !== null && maxMessageId !== null) {
			await query(
				`UPDATE roadmap.agency_liaison_session
         SET metadata = jsonb_set(
               jsonb_set(COALESCE(metadata, '{}'::jsonb),
                         '{drain_cursor_created_at}', to_jsonb($1::timestamptz)),
               '{drain_cursor_id}', to_jsonb($2::text))
         WHERE session_id = $3`,
				[maxCreatedAt, maxMessageId, sessionId],
			);
		}
	} catch (err) {
		// Query or transaction failed; propagate but results remain accessible.
		throw err;
	}

	return results;
}
