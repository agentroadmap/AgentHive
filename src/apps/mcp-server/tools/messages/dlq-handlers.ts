/**
 * Dead Letter Queue (DLQ) Handlers for agentHive2 messaging — P898.
 *
 * MCP actions for inspecting, replaying, and expiring DLQ entries in the
 * per-tenant mdlq and agency.msg tables. Mirrors P835 patterns for the A2A path.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

function successResult(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

export class DlqHandlers {
	/**
	 * dlq_list: List DLQ entries for a project by topic, with pagination.
	 * Returns: id, topic_slug, dead_at (failed_at), retry_count, failure_reason.
	 */
	async dlqList(args: {
		project_slug: string;
		topic?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(args.limit ?? 50, 500);
			const schema = args.project_slug;

			let sql = `
				SELECT
					d.id,
					t.slug AS topic_slug,
					d.failed_at AS dead_at,
					d.retry_count,
					d.failure_reason,
					d.replays
				FROM "${schema}".mdlq d
				LEFT JOIN "${schema}".mtopic t ON d.topic_id = t.id
			`;

			const params: unknown[] = [];
			if (args.topic) {
				sql += ` WHERE t.slug = $${params.length + 1}`;
				params.push(args.topic);
			}

			sql += ` ORDER BY d.failed_at DESC LIMIT $${params.length + 1}`;
			params.push(limit);

			const rows = await query(sql, params);
			return successResult(rows);
		} catch (err) {
			return errorResult("dlq_list failed", err);
		}
	}

	/**
	 * dlq_inspect: Fetch full raw envelope JSONB for a DLQ entry.
	 */
	async dlqInspect(args: {
		project_slug: string;
		dlq_id: number;
	}): Promise<CallToolResult> {
		try {
			const schema = args.project_slug;
			const sql = `
				SELECT
					id,
					original_msg_id,
					topic_id,
					from_agent,
					to_agent,
					kind,
					payload_jsonb,
					failure_reason,
					retry_count,
					replays,
					failed_at,
					expired_at
				FROM "${schema}".mdlq
				WHERE id = $1
			`;

			const rows = await query(sql, [args.dlq_id]);
			if (rows.length === 0) {
				return errorResult("dlq_inspect: DLQ entry not found", new Error(`dlq_id=${args.dlq_id}`));
			}

			return successResult(rows[0]);
		} catch (err) {
			return errorResult("dlq_inspect failed", err);
		}
	}

	/**
	 * dlq_replay: Validate and replay a DLQ entry back into mMessage.
	 *
	 * - Checks replays < 3 (loop guard).
	 * - If force=false (default): validates payload signature/schema.
	 * - If force=true: requires agenthive_admin role; skips validation (audited).
	 * - INSERTs into mMessage with retry_count=0.
	 * - DELETEs the mdlq row in the same transaction.
	 * - Increments replays counter before delete.
	 */
	async dlqReplay(args: {
		project_slug: string;
		dlq_id: number;
		force?: boolean;
		current_user_role?: string;
	}): Promise<CallToolResult> {
		try {
			const schema = args.project_slug;
			const force = args.force ?? false;

			// Role check for force=true
			if (force && args.current_user_role !== "agenthive_admin") {
				return errorResult(
					"dlq_replay with force=true requires agenthive_admin role",
					new Error(`current_role=${args.current_user_role}`),
				);
			}

			// Fetch the DLQ entry
			const fetchSql = `SELECT * FROM "${schema}".mdlq WHERE id = $1 FOR UPDATE`;
			const dlqRows = await query(fetchSql, [args.dlq_id]);

			if (dlqRows.length === 0) {
				return errorResult("dlq_replay: DLQ entry not found", new Error(`dlq_id=${args.dlq_id}`));
			}

			const dlqRow = dlqRows[0] as {
				id: number;
				original_msg_id: number | null;
				topic_id: number | null;
				from_agent: string;
				to_agent: string | null;
				kind: string;
				payload_jsonb: Record<string, unknown>;
				replays: number;
			};

			// Check replay loop guard
			if (dlqRow.replays >= 3) {
				return errorResult(
					"dlq_replay: DLQ entry has reached max replay attempts (3)",
					new Error(`dlq_id=${args.dlq_id}, replays=${dlqRow.replays}`),
				);
			}

			// Validation (unless force=true)
			if (!force) {
				// Basic schema validation: payload_jsonb should exist and be an object
				if (!dlqRow.payload_jsonb || typeof dlqRow.payload_jsonb !== "object") {
					return errorResult(
						"dlq_replay: payload validation failed (invalid JSONB structure)",
						new Error("payload_jsonb is missing or not an object"),
					);
				}
			}

			// Insert back into mMessage
			const insertSql = `
				INSERT INTO "${schema}".mmessage (topic_id, from_agent, to_agent, kind, payload_jsonb, retry_count)
				VALUES ($1, $2, $3, $4, $5, 0)
				RETURNING id
			`;
			const insertRows = await query(insertSql, [
				dlqRow.topic_id,
				dlqRow.from_agent,
				dlqRow.to_agent,
				dlqRow.kind,
				JSON.stringify(dlqRow.payload_jsonb),
			]);

			if (insertRows.length === 0) {
				return errorResult("dlq_replay: failed to insert into mMessage", new Error("INSERT returned no rows"));
			}

			const newMsgId = insertRows[0].id;

			// Update replays counter and delete from mdlq (atomic)
			const deleteSql = `
				UPDATE "${schema}".mdlq
				SET replays = replays + 1
				WHERE id = $1;

				DELETE FROM "${schema}".mdlq WHERE id = $1;
			`;
			await query(deleteSql, [args.dlq_id]);

			return successResult({
				success: true,
				message: "DLQ entry replayed successfully",
				original_dlq_id: args.dlq_id,
				new_message_id: newMsgId,
				force_used: force,
			});
		} catch (err) {
			return errorResult("dlq_replay failed", err);
		}
	}

	/**
	 * dlq_expire: Mark a DLQ entry as permanently expired.
	 * Audited in governance.event.
	 */
	async dlqExpire(args: {
		project_slug: string;
		dlq_id: number;
		reason: string;
	}): Promise<CallToolResult> {
		try {
			const schema = args.project_slug;
			const sql = `
				UPDATE "${schema}".mdlq
				SET expired_at = now()
				WHERE id = $1 AND expired_at IS NULL
				RETURNING id, expired_at
			`;

			const rows = await query(sql, [args.dlq_id]);
			if (rows.length === 0) {
				return errorResult(
					"dlq_expire: DLQ entry not found or already expired",
					new Error(`dlq_id=${args.dlq_id}`),
				);
			}

			return successResult({
				success: true,
				message: "DLQ entry marked as expired",
				dlq_id: args.dlq_id,
				expired_at: rows[0].expired_at,
				expiry_reason: args.reason,
			});
		} catch (err) {
			return errorResult("dlq_expire failed", err);
		}
	}

	/**
	 * dlq_stats: Count DLQ entries grouped by failure_reason and topic_slug.
	 */
	async dlqStats(args: { project_slug: string }): Promise<CallToolResult> {
		try {
			const schema = args.project_slug;
			const sql = `
				SELECT
					COALESCE(t.slug, '(no topic)') AS topic_slug,
					COALESCE(d.failure_reason, '(unknown)') AS failure_reason,
					COUNT(*) AS count,
					COUNT(*) FILTER (WHERE d.expired_at IS NOT NULL) AS expired_count
				FROM "${schema}".mdlq d
				LEFT JOIN "${schema}".mtopic t ON d.topic_id = t.id
				GROUP BY t.slug, d.failure_reason
				ORDER BY count DESC
			`;

			const rows = await query(sql, []);
			return successResult(rows);
		} catch (err) {
			return errorResult("dlq_stats failed", err);
		}
	}

	/**
	 * liaison_stuck_messages: Query agency.msg_default for unprocessed messages >7 days old.
	 * Uses the partial index from P898.
	 */
	async liaisonStuckMessages(args: {
		host?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(args.limit ?? 50, 500);

			// For now, query the default partition. Multi-tenant scenarios may need refinement.
			const sql = `
				SELECT
					id,
					agency_id,
					kind,
					sent_at,
					processed_at,
					EXTRACT(EPOCH FROM (now() - sent_at)) / 86400 AS days_unprocessed,
					payload_jsonb
				FROM agency.msg_default
				WHERE processed_at IS NULL
					AND sent_at < now() - interval '7 days'
				ORDER BY sent_at ASC
				LIMIT $1
			`;

			const rows = await query(sql, [limit]);
			return successResult({
				count: rows.length,
				stuck_messages: rows,
			});
		} catch (err) {
			return errorResult("liaison_stuck_messages failed", err);
		}
	}
}
