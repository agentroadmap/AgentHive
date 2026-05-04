/**
 * msg_ack: Acknowledge a message with outcome (ok|reject|noop)
 *
 * P833 Phase 2: Idempotent ACK handler
 * - Updates message_ledger.acked_at and ack_outcome
 * - Cancels timeout tracking by setting escalated_at = now()
 * - Returns existing outcome if already acked (idempotent)
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

export async function handleMsgAck(args: {
	message_id: number;
	outcome: "ok" | "reject" | "noop";
	reason?: string;
}): Promise<CallToolResult> {
	try {
		// Idempotent ACK: if already acked, return existing outcome without overwriting
		const checkResult = await query(
			`SELECT acked_at, ack_outcome FROM roadmap.message_ledger WHERE id = $1`,
			[args.message_id],
		);

		if (checkResult.rows.length === 0) {
			return errorResult(`Message ${args.message_id} not found`, new Error("NOT_FOUND"));
		}

		const existing = checkResult.rows[0];
		if (existing.acked_at !== null) {
			// Already acked — return existing outcome
			return {
				content: [
					{
						type: "text",
						text: `Message ${args.message_id} already acked with outcome: ${existing.ack_outcome}`,
					},
				],
			};
		}

		// Perform the ACK
		const updateResult = await query(
			`UPDATE roadmap.message_ledger
			 SET acked_at = now(), ack_outcome = $2
			 WHERE id = $1 AND acked_at IS NULL
			 RETURNING acked_at, ack_outcome`,
			[args.message_id, args.outcome],
		);

		if (updateResult.rows.length === 0) {
			return errorResult(
				`Failed to ack message ${args.message_id}`,
				new Error("NO_ROWS_UPDATED"),
			);
		}

		// Cancel pending timeout escalation by setting escalated_at = now()
		await query(
			`UPDATE roadmap.message_timeout_tracking
			 SET escalated_at = now()
			 WHERE message_id = $1 AND escalated_at IS NULL`,
			[args.message_id],
		);

		return {
			content: [
				{
					type: "text",
					text: `Message ${args.message_id} acked with outcome: ${args.outcome}${args.reason ? ` (reason: ${args.reason})` : ""}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to ack message", err);
	}
}
