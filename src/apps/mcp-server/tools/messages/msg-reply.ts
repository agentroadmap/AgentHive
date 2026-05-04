/**
 * msg_reply: Reply to a message using correlation_id
 *
 * P833 Phase 2: Reply handler with auto-ack
 * - Finds original message by correlation_id and to_agent
 * - INSERTs reply with same correlation_id and swapped from/to
 * - Auto-acks the original message
 * - Notifies recipient via pg_notify
 * - Returns reply_message_id
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

export async function handleMsgReply(args: {
	correlation_id: string;
	content: string;
	message_type?: string;
	from_agent: string;
}): Promise<CallToolResult> {
	try {
		// Find original message: SELECT * FROM message_ledger WHERE correlation_id = $correlation_id AND to_agent = $from_agent ORDER BY created_at LIMIT 1
		const originalResult = await query(
			`SELECT id, from_agent, to_agent, correlation_id
			 FROM roadmap.message_ledger
			 WHERE correlation_id = $1 AND to_agent = $2
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[args.correlation_id, args.from_agent],
		);

		if (originalResult.rows.length === 0) {
			return errorResult(
				`No original message found with correlation_id ${args.correlation_id} for agent ${args.from_agent}`,
				new Error("NOT_FOUND"),
			);
		}

		const original = originalResult.rows[0];
		const recipientAgent = original.from_agent;

		// INSERT new reply row into message_ledger with same correlation_id, from_agent=$from_agent, to_agent=original.from_agent
		const replyResult = await query(
			`INSERT INTO roadmap.message_ledger (
				from_agent, to_agent, message_content, message_type, correlation_id
			) VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, created_at`,
			[args.from_agent, recipientAgent, args.content, args.message_type ?? "ack", args.correlation_id],
		);

		const replyId = replyResult.rows[0].id;

		// Auto-ack the original message with outcome='ok'
		await query(
			`UPDATE roadmap.message_ledger
			 SET acked_at = now(), ack_outcome = 'ok'
			 WHERE id = $1 AND acked_at IS NULL`,
			[original.id],
		);

		// Cancel pending timeout escalation on the original
		await query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = now()
			 WHERE message_id = $1 AND escalated_at IS NULL`,
			[original.id],
		);

		// pg_notify the recipient on channel a2a_msg_${recipientAgent}
		const pool = getPool();
		const client = await pool.connect();
		try {
			await client.query(
				`SELECT pg_notify(
					'a2a_msg_' || $1,
					json_build_object(
						'message_id', $2,
						'from_agent', $3,
						'channel', null,
						'message_type', $4
					)::text
				)`,
				[recipientAgent, replyId, args.from_agent, args.message_type ?? "ack"],
			);
		} finally {
			client.release();
		}

		return {
			content: [
				{
					type: "text",
					text: `Reply sent (id: ${replyId}) to ${recipientAgent} with correlation_id: ${args.correlation_id}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to send reply", err);
	}
}
