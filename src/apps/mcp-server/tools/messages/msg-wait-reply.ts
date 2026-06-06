/**
 * msg_wait_reply: Wait for a reply to a message
 *
 * P833 Phase 2: Reply waiter with pg_notify + fallback polling
 * - Looks up correlation_id for the given message_id
 * - Subscribes to pg_notify channel msg_${agent} (via agentNotifyChannel), filters by correlation_id
 * - Poll fallback every 5s: SELECT id FROM message_ledger WHERE correlation_id = $cid AND acked_at IS NOT NULL
 * - On timeout_ms exceeded: INSERT into message_timeout_tracking (idempotent via UNIQUE on message_id)
 * - Returns { replied: boolean, reply_message_id?: number, timed_out: boolean }
 *
 * P1105 AC-27: user/* agents require bearer token verification
 */

import { query, getPool } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";
import { verifyUserBearer } from "../../../../infra/messaging/bearer-auth.ts";
import { agentNotifyChannel } from "../../../../infra/messaging/a2a-access-control.ts";

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

const REPLY_QUERY = `
	SELECT id FROM roadmap.message_ledger
	WHERE correlation_id = $1
	AND (to_agent = $2 OR channel IS NOT NULL)
	AND acked_at IS NOT NULL
	ORDER BY created_at DESC
	LIMIT 1`;

/**
 * Wait for a reply notification on the canonical msg_{agent} channel.
 * On each pg_notify, queries DB for matching replied correlation_id.
 * Falls back to 5s interval polling if notify is missed.
 */
async function waitForReplyViaNotify(
	agent: string,
	correlationId: string,
	timeoutMs: number,
): Promise<{ replied: boolean; replyMessageId?: number }> {
	const pool = getPool();
	const client = await pool.connect();
	// P1103 AC-2: use canonical msg_<identity> channel (agentNotifyChannel),
	// matching fn_a2a_message_notify (migration 169). Old a2a_msg_ prefix silently missed.
	const pgChannel = agentNotifyChannel(agent);

	try {
		await client.query(`LISTEN "${pgChannel}"`);

		// Immediate check — reply may have arrived before we started listening
		const immediate = await client.query(REPLY_QUERY, [correlationId, agent]);
		if (immediate.rows.length > 0) {
			return { replied: true, replyMessageId: immediate.rows[0].id };
		}

		return await new Promise((resolve) => {
			let resolved = false;

			const finish = (result: { replied: boolean; replyMessageId?: number }) => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutHandle);
					clearInterval(pollInterval);
					client.removeListener("notification", handler);
					resolve(result);
				}
			};

			const timeoutHandle = setTimeout(() => finish({ replied: false }), timeoutMs);

			// Interval fallback every 5s in case pg_notify is dropped
			const pollInterval = setInterval(async () => {
				try {
					const result = await client.query(REPLY_QUERY, [correlationId, agent]);
					if (result.rows.length > 0) {
						finish({ replied: true, replyMessageId: result.rows[0].id });
					}
				} catch {
					// ignore — timeout will fire eventually
				}
			}, 5000);

			const handler = async (msg: any) => {
				if (msg.channel !== pgChannel || resolved) return;
				try {
					const result = await client.query(REPLY_QUERY, [correlationId, agent]);
					if (result.rows.length > 0) {
						finish({ replied: true, replyMessageId: result.rows[0].id });
					}
				} catch {
					// ignore — interval will retry
				}
			};

			client.on("notification", handler);
		});
	} finally {
		try {
			await client.query(`UNLISTEN "${pgChannel}"`);
		} catch {
			// ignore cleanup errors
		}
		client.release();
	}
}

export async function handleMsgWaitReply(
	args: {
		message_id: number;
		timeout_ms: number;
		agent: string;
		authorization?: string;
	},
	operatorHmacSecret?: Buffer,
): Promise<CallToolResult> {
	try {
		// P1105 AC-27: Verify user/* agents have valid bearer token
		if (operatorHmacSecret) {
			const bearerCheck = verifyUserBearer(
				args.authorization,
				args.agent,
				operatorHmacSecret,
			);
			if (!bearerCheck.valid) {
				return errorResult(
					`Authentication failed (P1105 AC-27): ${bearerCheck.reason}`,
					new Error(bearerCheck.reason),
				);
			}
		}

		// Look up correlation_id for the given message_id
		const msgResult = await query(
			`SELECT correlation_id, from_agent FROM roadmap.message_ledger WHERE id = $1`,
			[args.message_id],
		);

		if (msgResult.rows.length === 0) {
			return errorResult(`Message ${args.message_id} not found`, new Error("NOT_FOUND"));
		}

		const { correlation_id } = msgResult.rows[0];

		if (!correlation_id) {
			return errorResult(
				`Message ${args.message_id} has no correlation_id`,
				new Error("NO_CORRELATION_ID"),
			);
		}

		const timeoutMs = Math.min(Math.max(args.timeout_ms, 0), 300000); // Cap at 5 minutes

		const pollResult = await waitForReplyViaNotify(correlation_id, args.agent, timeoutMs);

		if (pollResult.replied && pollResult.replyMessageId) {
			return {
				content: [
					{
						type: "text",
						text: `Reply received: message_id ${pollResult.replyMessageId}`,
					},
				],
			};
		}

		// Timeout occurred — record in message_timeout_tracking (idempotent via UNIQUE on message_id)
		const timedOut = !pollResult.replied;

		if (timedOut) {
			try {
				await query(
					`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
					 VALUES ($1, now(), 'liaison_hub')
					 ON CONFLICT (message_id) DO NOTHING`,
					[args.message_id],
				);
			} catch {
				// Idempotent — ignore conflicts
			}
		}

		return {
			content: [
				{
					type: "text",
					text: `No reply received after ${timeoutMs}ms. timed_out: ${timedOut}`,
				},
			],
		};
	} catch (err) {
		return errorResult("Failed to wait for reply", err);
	}
}
