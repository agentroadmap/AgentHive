/**
 * Dead Letter Queue (DLQ) Handlers for AgentHive2 Messaging
 *
 * Provides operational surface for inspecting, replaying, and expiring
 * messages in the mDLQ table (per-project dead-letter queue).
 * Also includes liaison message inspection via agency.msg_default.
 *
 * P898: DLQ replay/inspect/expire MCP actions
 */

import { query, getPool } from "../../../../postgres/pool.ts";
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

/**
 * dlq_list: List DLQ entries for a project.
 * Returns: id, topic_slug, dead_at, retry_count, replays, failure_reason
 */
export async function dlqList(args: {
	project_slug: string;
	topic?: string;
	limit?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
		const schemaName = args.project_slug; // assuming project_slug maps to schema

		let whereClause = "";
		const params: any[] = [limit];
		let paramIdx = 2;

		if (args.topic) {
			whereClause = `WHERE topic_id = (SELECT id FROM ${schemaName}.mTopic WHERE slug = $${paramIdx})`;
			params.push(args.topic);
			paramIdx++;
		}

		const sql = `
      SELECT
        id,
        (SELECT slug FROM ${schemaName}.mTopic WHERE id = topic_id) AS topic_slug,
        failed_at AS dead_at,
        retry_count,
        replays,
        failure_reason
      FROM ${schemaName}.mDLQ
      ${whereClause}
      ORDER BY failed_at DESC
      LIMIT $1
    `;

		const { rows } = await query(sql, params);

		if (!rows || rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No DLQ entries found for project '${args.project_slug}'${args.topic ? ` topic '${args.topic}'` : ""}.`,
					},
				],
			};
		}

		const lines = rows.map(
			(r: any) =>
				`[${r.id}] topic: ${r.topic_slug || "unknown"}, dead_at: ${r.dead_at}, ` +
				`retries: ${r.retry_count}, replays: ${r.replays}, reason: ${r.failure_reason || "unknown"}`,
		);

		return {
			content: [
				{
					type: "text",
					text: `## DLQ Entries (${rows.length}/${limit})\n\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to list DLQ entries", err);
	}
}

/**
 * dlq_inspect: Get full details of a DLQ entry.
 */
export async function dlqInspect(args: {
	project_slug: string;
	dlq_id: string;
}): Promise<CallToolResult> {
	try {
		const schemaName = args.project_slug;
		const dlqId = parseInt(args.dlq_id, 10);

		if (isNaN(dlqId)) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ Invalid dlq_id: '${args.dlq_id}' (expected numeric)`,
					},
				],
			};
		}

		const { rows } = await query(
			`
      SELECT
        id,
        original_msg_id,
        (SELECT slug FROM ${schemaName}.mTopic WHERE id = topic_id) AS topic_slug,
        from_agent,
        to_agent,
        kind,
        payload_jsonb,
        failure_reason,
        retry_count,
        replays,
        failed_at,
        expired_at
      FROM ${schemaName}.mDLQ
      WHERE id = $1
    `,
			[dlqId],
		);

		if (!rows || rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `DLQ entry ${dlqId} not found in project '${args.project_slug}'.`,
					},
				],
			};
		}

		const row = rows[0];
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(row, null, 2),
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to inspect DLQ entry", err);
	}
}

/**
 * dlq_replay: Replay a DLQ message by inserting it back into mMessage and deleting from mDLQ.
 *
 * Guards:
 * - Rejects if replays >= 3
 * - force=true allows bypass (audit trail via governance.event)
 *
 * Transaction:
 * 1. Check replays < 3 (or force=true)
 * 2. INSERT into mMessage from mdlq row
 * 3. DELETE from mDLQ
 */
export async function dlqReplay(args: {
	project_slug: string;
	dlq_id: string;
	force?: boolean;
}): Promise<CallToolResult> {
	try {
		const schemaName = args.project_slug;
		const dlqId = parseInt(args.dlq_id, 10);

		if (isNaN(dlqId)) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ Invalid dlq_id: '${args.dlq_id}' (expected numeric)`,
					},
				],
			};
		}

		// Fetch the DLQ entry
		const { rows: dlqRows } = await query(
			`SELECT * FROM ${schemaName}.mDLQ WHERE id = $1`,
			[dlqId],
		);

		if (!dlqRows || dlqRows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `DLQ entry ${dlqId} not found.`,
					},
				],
			};
		}

		const dlqEntry = dlqRows[0];

		// Check replay limit
		if (dlqEntry.replays >= 3 && !args.force) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ DLQ entry ${dlqId} has reached max replay attempts (${dlqEntry.replays}). Use force=true to override.`,
					},
				],
			};
		}

		// If force=true, audit the action (governance.event) — optional if no auth context
		if (args.force) {
			try {
				await query(
					`INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
           VALUES ('dlq_force_replay', $1, $2, $3)`,
					[
						"mcp_dlq_handler", // actor_did
						String(dlqId), // subject_ref
						JSON.stringify({
							project_slug: args.project_slug,
							dlq_id: dlqId,
							replays: dlqEntry.replays,
						}),
					],
				);
			} catch (auditErr) {
				// Log but don't fail on audit error
				console.warn("Failed to audit dlq_force_replay:", auditErr);
			}
		}

		// Begin transaction: INSERT into mMessage, DELETE from mDLQ
		const client = await getPool().connect();
		try {
			await client.query("BEGIN");

			// Insert into mMessage with retry_count = 0
			const { rows: msgRows } = await client.query(
				`INSERT INTO ${schemaName}.mMessage (
          topic_id, from_agent, to_agent, kind, payload_jsonb, correlation_id, retry_count
        ) VALUES ($1, $2, $3, $4, $5, $6, 0)
        RETURNING id`,
				[
					dlqEntry.topic_id,
					dlqEntry.from_agent,
					dlqEntry.to_agent,
					dlqEntry.kind,
					dlqEntry.payload_jsonb,
					null, // No correlation_id for replayed messages
				],
			);

			const newMsgId = msgRows[0].id;

			// Delete from mDLQ
			await client.query(`DELETE FROM ${schemaName}.mDLQ WHERE id = $1`, [dlqId]);

			await client.query("COMMIT");

			return {
				content: [
					{
						type: "text",
						text: `✓ DLQ entry ${dlqId} replayed as mMessage ${newMsgId}`,
					},
				],
			};
		} catch (txErr) {
			await client.query("ROLLBACK");
			throw txErr;
		} finally {
			client.release();
		}
	} catch (err) {
		return errorResult("Failed to replay DLQ entry", err);
	}
}

/**
 * dlq_expire: Mark a DLQ entry as expired without deleting (audit trail).
 *
 * Rejects if already expired.
 * Updates expired_at, then writes to governance.event.
 */
export async function dlqExpire(args: {
	project_slug: string;
	dlq_id: string;
	reason: string;
}): Promise<CallToolResult> {
	try {
		const schemaName = args.project_slug;
		const dlqId = parseInt(args.dlq_id, 10);

		if (isNaN(dlqId)) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ Invalid dlq_id: '${args.dlq_id}' (expected numeric)`,
					},
				],
			};
		}

		// Check if already expired
		const { rows: checkRows } = await query(
			`SELECT expired_at FROM ${schemaName}.mDLQ WHERE id = $1`,
			[dlqId],
		);

		if (!checkRows || checkRows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `DLQ entry ${dlqId} not found.`,
					},
				],
			};
		}

		if (checkRows[0].expired_at !== null) {
			return {
				content: [
					{
						type: "text",
						text: `⚠️ DLQ entry ${dlqId} is already expired at ${checkRows[0].expired_at}.`,
					},
				],
			};
		}

		// Update expired_at
		await query(`UPDATE ${schemaName}.mDLQ SET expired_at = now() WHERE id = $1`, [
			dlqId,
		]);

		// Write audit event
		try {
			await query(
				`INSERT INTO governance.event (event_type, actor_did, subject_ref, payload_jsonb)
         VALUES ('dlq_expire', $1, $2, $3)`,
				[
					"mcp_dlq_handler", // actor_did
					String(dlqId), // subject_ref
					JSON.stringify({
						project_slug: args.project_slug,
						dlq_id: dlqId,
						reason: args.reason,
					}),
				],
			);
		} catch (auditErr) {
			console.warn("Failed to audit dlq_expire:", auditErr);
		}

		return {
			content: [
				{
					type: "text",
					text: `✓ DLQ entry ${dlqId} marked as expired. Reason: ${args.reason}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to expire DLQ entry", err);
	}
}

/**
 * dlq_stats: Get aggregated DLQ statistics.
 *
 * Groups by failure_reason, counts total and expired.
 */
export async function dlqStats(args: {
	project_slug: string;
}): Promise<CallToolResult> {
	try {
		const schemaName = args.project_slug;

		const { rows } = await query(
			`
      SELECT
        failure_reason,
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE expired_at IS NOT NULL) AS expired_count
      FROM ${schemaName}.mDLQ
      GROUP BY failure_reason
      ORDER BY total_count DESC
    `,
			[],
		);

		if (!rows || rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No DLQ entries found for project '${args.project_slug}'.`,
					},
				],
			};
		}

		const lines = rows.map(
			(r: any) =>
				`- **${r.failure_reason || "unknown"}**: ${r.total_count} total, ${r.expired_count} expired`,
		);

		return {
			content: [
				{
					type: "text",
					text: `## DLQ Statistics\n\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to fetch DLQ stats", err);
	}
}

/**
 * liaison_stuck_messages: Find liaison messages that haven't been processed.
 *
 * Filters agency.msg_default where processed_at IS NULL and sent_at is older than threshold.
 * Uses partial index for performance.
 */
export async function liaisonStuckMessages(args: {
	project_slug: string;
	threshold_days?: number;
}): Promise<CallToolResult> {
	try {
		const thresholdDays = args.threshold_days ?? 7;

		const { rows } = await query(
			`
      SELECT
        id,
        agency_id,
        kind,
        sent_at,
        processed_at,
        payload_jsonb
      FROM agency.msg_default
      WHERE processed_at IS NULL
        AND sent_at < now() - interval '${thresholdDays} days'
      ORDER BY sent_at ASC
    `,
			[],
		);

		if (!rows || rows.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `No stuck liaison messages found (threshold: ${thresholdDays} days).`,
					},
				],
			};
		}

		const lines = rows.map(
			(r: any) =>
				`[${r.id}] agency_id: ${r.agency_id}, kind: ${r.kind}, sent_at: ${r.sent_at}`,
		);

		return {
			content: [
				{
					type: "text",
					text: `## Stuck Liaison Messages (${rows.length})\n\n${lines.join("\n")}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to fetch stuck liaison messages", err);
	}
}
