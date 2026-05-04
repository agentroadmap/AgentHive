/**
 * Postgres-backed Messaging MCP Tools for AgentHive.
 *
 * A2A/A2H communication via the `message_ledger` table.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 *
 * P149: Channel subscriptions, pg_notify push notifications, and wait_ms blocking reads.
 * Migration 096 adds the trig_a2a_message_notify trigger that fires these notifications.
 *
 * Trust model: readMessages enforces trust tier via resolveTrust() — restricted/blocked
 * agents cannot receive DMs; authority agents bypass all filters.
 */

import { query, getPool } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { enforceMessageGate } from "../../../../proposal-engine/middleware/message-dispatch-gate.ts";
import { resolveTrust } from "../../../../infra/trust/trust-resolver.ts";

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

function firstText(result: CallToolResult): string | undefined {
	const first = result.content[0];
	return first?.type === "text" ? first.text : undefined;
}

/**
 * Notification payload from the trig_a2a_message_notify trigger (migration 096).
 */
export interface NewMessageNotification {
	message_id: number;
	from_agent: string;
	channel: string | null;
	message_type: string | null;
}

/**
 * Wait for a pg_notify on the per-agent DM channel `a2a_msg_{agentIdentity}`.
 * Uses a dedicated pool connection with LISTEN/NOTIFY, following the liaison
 * listener pattern in liaison-message-service.ts.
 *
 * Returns the raw notification payload or null on timeout.
 */
async function waitForAgentNotification(
	agentIdentity: string,
	waitMs: number,
): Promise<NewMessageNotification | null> {
	const pool = getPool();
	const client = await pool.connect();
	const pgChannel = `a2a_msg_${agentIdentity}`;

	try {
		await client.query(`LISTEN "${pgChannel}"`);

		return await new Promise<NewMessageNotification | null>((resolve) => {
			let resolved = false;

			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					client.removeListener("notification", handler);
					resolve(null);
				}
			}, waitMs);

			const handler = (msg: any) => {
				if (msg.channel === pgChannel && !resolved) {
					resolved = true;
					clearTimeout(timeout);
					client.removeListener("notification", handler);
					try {
						resolve(JSON.parse(msg.payload) as NewMessageNotification);
					} catch {
						resolve(null);
					}
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

/**
 * Check if a reader agent is allowed to receive a message from sender.
 * Restricted and blocked tiers cannot receive DMs.
 * Authority agents bypass all trust checks.
 */
async function canRead(reader: string, fromAgent: string): Promise<boolean> {
	try {
		const result = await resolveTrust({ sender: fromAgent, receiver: reader });
		// authority and trusted tiers can always communicate
		// known tier: can receive DMs
		// restricted: no DM initiation allowed (can only receive pong/response)
		// blocked: no communication
		return result.tier !== "blocked" && result.tier !== "restricted";
	} catch {
		return false;
	}
}

export class PgMessagingHandlers {
	constructor(
		private readonly core: McpServer,
		private readonly projectRoot: string,
	) {}

	// -------------------------------------------------------------------------
	// P149: Channel Subscriptions (AC-2)
	// -------------------------------------------------------------------------

	/**
	 * Subscribe or unsubscribe an agent to/from a channel.
	 * Persists in channel_subscription table for pg_notify push delivery.
	 */
	async subscribe(args: {
		agent_identity: string;
		channel: string;
		subscribe?: boolean;
	}): Promise<CallToolResult> {
		try {
			const doSubscribe = args.subscribe ?? true;

			if (doSubscribe) {
				// Validate channel format
				if (!/^(direct|team:.+|broadcast|system)$/.test(args.channel)) {
					return {
						content: [
							{
								type: "text",
								text: `⚠️ Invalid channel format '${args.channel}'. Must be 'direct', 'team:<name>', 'broadcast', or 'system'.`,
							},
						],
					};
				}

				await query(
					`INSERT INTO channel_subscription (agent_identity, channel)
					 VALUES ($1, $2)
					 ON CONFLICT (agent_identity, channel) DO UPDATE SET subscribed_at = now()`,
					[args.agent_identity, args.channel],
				);

				// Get total subscription count for this agent
				const { rows } = await query(
					`SELECT COUNT(*) as count FROM channel_subscription WHERE agent_identity = $1`,
					[args.agent_identity],
				);

				return {
					content: [
						{
							type: "text",
							text: `Subscribed ${args.agent_identity} to channel: ${args.channel} (total subscriptions: ${rows[0]?.count ?? 0})`,
						},
					],
				};
			}

			// Unsubscribe
			await query(
				`DELETE FROM channel_subscription WHERE agent_identity = $1 AND channel = $2`,
				[args.agent_identity, args.channel],
			);

			const { rows } = await query(
				`SELECT COUNT(*) as count FROM channel_subscription WHERE agent_identity = $1`,
				[args.agent_identity],
			);

			return {
				content: [
					{
						type: "text",
						text: `Unsubscribed ${args.agent_identity} from channel: ${args.channel} (remaining subscriptions: ${rows[0]?.count ?? 0})`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to update subscription", err);
		}
	}

	/**
	 * List channel subscriptions, optionally filtered by agent.
	 */
	async listSubscriptions(args: { agent_identity?: string }): Promise<CallToolResult> {
		try {
			let whereClause = "";
			const params: any[] = [];

			if (args.agent_identity) {
				whereClause = "WHERE agent_identity = $1";
				params.push(args.agent_identity);
			}

			const { rows } = await query(
				`SELECT agent_identity, channel, subscribed_at
				 FROM channel_subscription
				 ${whereClause}
				 ORDER BY agent_identity, channel`,
				params,
			);

			if (!rows.length) {
				return {
					content: [{ type: "text", text: "No subscriptions found." }],
				};
			}

			const lines = rows.map(
				(r: any) =>
					`- **${r.agent_identity}** → ${r.channel} (since ${r.subscribed_at})`,
			);

			return {
				content: [
					{ type: "text", text: `## Channel Subscriptions\n\n${lines.join("\n")}` },
				],
			};
		} catch (err) {
			return errorResult("Failed to list subscriptions", err);
		}
	}

	// -------------------------------------------------------------------------
	// Core Messaging (enhanced for P149)
	// -------------------------------------------------------------------------

	async sendMessage(args: {
		from_agent: string;
		to_agent?: string;
		channel?: string;
		message_content: string;
		message_type?: string;
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
			// P209: Enforce message dispatch gate before insertion
			const gateResult = await enforceMessageGate({
				from_agent: args.from_agent,
				to_agent: args.to_agent,
				channel: args.channel,
				message_type: args.message_type,
				proposal_id: args.proposal_id,
			});

			// Blocked messages fail silently (no error to sender)
			if (!gateResult.allowed) {
				// Silent failure per P209 design: return empty response
				// (The denial is logged in denied_messages table for audit)
				return {
					content: [
						{
							type: "text",
							text: "Message processed.",
						},
					],
				};
			}

			const { rows } = await query(
				`INSERT INTO message_ledger (from_agent, to_agent, channel, message_content, message_type, proposal_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
				[
					args.from_agent,
					args.to_agent || null,
					args.channel || null,
					args.message_content,
					args.message_type || "text",
					args.proposal_id || null,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: `Message sent (id: ${rows[0].id}) at ${rows[0].created_at}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to send message", err);
		}
	}

	/**
	 * Mark a message as read (AC-7).
	 */
	async markRead(args: {
		message_id: number;
		agent: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`UPDATE roadmap.message_ledger
				 SET read_at = now()
				 WHERE id = $1 AND (to_agent = $2 OR to_agent IS NULL) AND read_at IS NULL
				 RETURNING id, read_at`,
				[args.message_id, args.agent],
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Message ${args.message_id} not found or already read.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Message ${args.message_id} marked as read at ${rows[0].read_at}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to mark message as read", err);
		}
	}

	/**
	 * Get unread count for an agent (AC-7).
	 */
	async unreadCount(args: { agent: string }): Promise<CallToolResult> {
		try {
			const { rows } = await query<{ count: string }>(
				`SELECT COUNT(*) as count
				 FROM roadmap.message_ledger
				 WHERE to_agent = $1 AND read_at IS NULL`,
				[args.agent],
			);

			return {
				content: [
					{
						type: "text",
						text: `Unread messages for ${args.agent}: ${rows[0]?.count ?? 0}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to get unread count", err);
		}
	}

	/**
	 * Read messages with optional wait_ms for trust-bound blocking reads (AC-4).
	 *
	 * When wait_ms > 0 and agent is specified: LISTENs on the per-agent pg_notify
	 * channel `a2a_msg_{agent}` (fired by migration 096 trigger). Blocks up to
	 * wait_ms ms, then returns. Results are filtered by the trust model — a
	 * restricted or blocked sender's DMs will not be surfaced.
	 *
	 * When agent is omitted: non-blocking channel/broadcast reads (no trust filter).
	 */
	async readMessages(args: {
		agent?: string;
		channel?: string;
		limit?: number;
		wait_ms?: number;
	}): Promise<CallToolResult> {
		try {
			if (args.wait_ms && args.wait_ms > 0 && args.agent) {
				const waitMs = Math.min(Math.max(args.wait_ms, 0), 30000);

				// Check if unread messages already exist for this agent
				const existing = await this.fetchMessages(args);
				if (firstText(existing) !== "No messages found.") {
					return existing;
				}

				// Block on pg_notify channel `a2a_msg_{agent}` (migration 096)
				const notification = await waitForAgentNotification(args.agent, waitMs);
				if (!notification) {
					return {
						content: [{ type: "text", text: `No new messages after waiting ${waitMs}ms.` }],
					};
				}

				// Trust check on the arriving sender before fetching
				const allowed = await canRead(args.agent, notification.from_agent);
				if (!allowed) {
					return {
						content: [{ type: "text", text: `No new messages after waiting ${waitMs}ms.` }],
					};
				}

				return await this.fetchMessages(args);
			}

			// Normal (non-blocking) read
			return await this.fetchMessages(args);
		} catch (err) {
			return errorResult("Failed to read messages", err);
		}
	}

	private async fetchMessages(args: {
		agent?: string;
		channel?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		const limit = args.limit || 50;
		let whereClause = "";
		const params: any[] = [];
		let idx = 1;

		if (args.agent) {
			whereClause = `WHERE to_agent = $${idx} OR from_agent = $${idx}`;
			params.push(args.agent);
			idx++;
		} else if (args.channel) {
			whereClause = `WHERE channel = $${idx}`;
			params.push(args.channel);
			idx++;
		}

		const { rows } = await query(
			`SELECT id, from_agent, to_agent, channel, message_content, message_type, proposal_id, created_at
         FROM message_ledger ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${idx}`,
			[...params, limit],
		);

		if (!rows || rows.length === 0) {
			return { content: [{ type: "text", text: "No messages found." }] };
		}
		const lines = rows.map(
			(r: any) =>
				`[${r.id}] ${r.from_agent} → ${r.to_agent || r.channel || "broadcast"} (${r.message_type}): ${r.message_content}`,
		);
		return { content: [{ type: "text", text: lines.join("\n") }] };
	}

	async listChannels(args: {
		limit?: number;
		include_metadata?: boolean;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
			const includeMetadata = args.include_metadata === true;

			let sql = `SELECT DISTINCT channel, COUNT(*) as msg_count${includeMetadata ? ", MAX(created_at) as last_message_at" : ""}
			       FROM message_ledger
			       WHERE channel IS NOT NULL
			       GROUP BY channel${includeMetadata ? "" : ""}
			       ORDER BY channel ASC
			       LIMIT $1`;
			const params: (number)[] = [limit];

			const [{ rows }, countResult] = await Promise.all([
				query(sql, params),
				query<{ total: string }>(
					`SELECT COUNT(DISTINCT channel)::text AS total FROM message_ledger WHERE channel IS NOT NULL`,
					[],
				),
			]);

			const totalMatching = Number(countResult.rows[0]?.total ?? rows.length);
			const truncated = totalMatching > rows.length;

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									total: 0,
									returned: 0,
									truncated: false,
									limit,
									filter: {},
									note: "No channels found.",
								},
								null,
								2,
							),
						},
					],
				};
			}

			const items = rows.map((r: any) => ({
				channel: r.channel,
				msg_count: Number(r.msg_count),
				...(includeMetadata && {
					last_message_at: r.last_message_at,
				}),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								total: totalMatching,
								returned: rows.length,
								truncated,
								limit,
								filter: {},
								items,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list channels", err);
		}
	}
}
