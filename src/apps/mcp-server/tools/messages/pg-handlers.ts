/**
 * Postgres-backed Messaging MCP Tools for AgentHive.
 *
 * A2A/A2H communication via the `message_ledger` table.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 *
 * P149: Added channel subscriptions, pg_notify push notifications, and wait_ms blocking reads.
 */

import {
	agentNotifyChannel,
	checkMessageACL,
} from "../../../../infra/messaging/a2a-access-control.ts";
import type { A2ANotification } from "../../../../infra/messaging/a2a-types.ts";
import { agentContextStorage } from "../../../../shared/identity/agent-context.ts";
import { getPool, query } from "../../../../postgres/pool.ts";
import { agentContextStorage } from "../../../../shared/identity/agent-context.ts";
import type { McpServer } from "../../server.ts";
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

function firstText(result: CallToolResult): string | undefined {
	const first = result.content[0];
	return first?.type === "text" ? first.text : undefined;
}

/** @deprecated Use A2ANotification from a2a-types.ts instead. */
export type NewMessageNotification = A2ANotification;

/**
 * P199: Listener for a specific agent's dedicated pg_notify channel.
 *
 * Replaces the old 'new_message' broadcast listener with a per-agent
 * channel (a2a_msg_<identity>) so that each agent only receives
 * notifications addressed to them. The exact channel name is produced
 * by agentNotifyChannel() and MUST match the channel emitted by
 * roadmap.fn_a2a_message_notify (migration 096).
 *
 * AC#3: No broadcast fallback — the trigger no longer fires on 'new_message'.
 */
export class MessageNotificationListener {
	private listenerClient: any = null;
	private started = false;
	private readonly pgChannel: string;

	/**
	 * @param agentIdentity - The agent identity to listen for.
	 *   Converted to a safe pg_notify channel name via agentNotifyChannel().
	 *   Falls back to legacy 'new_message' when omitted (deprecated).
	 */
	constructor(agentIdentity?: string) {
		this.pgChannel = agentIdentity
			? agentNotifyChannel(agentIdentity)
			: "new_message"; // legacy fallback — only used if caller passes no identity
	}

	async start(): Promise<void> {
		if (this.started) return;
		const pool = getPool();
		this.listenerClient = await pool.connect();
		await this.listenerClient.query(`LISTEN "${this.pgChannel}"`);
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started || !this.listenerClient) return;
		try {
			await this.listenerClient.query(`UNLISTEN "${this.pgChannel}"`);
		} catch {
			// ignore cleanup errors
		}
		this.listenerClient.release();
		this.listenerClient = null;
		this.started = false;
	}

	/**
	 * Wait for a notification on this agent's channel with timeout.
	 * Returns the parsed A2ANotification payload or null on timeout.
	 */
	async waitForMessage(waitMs: number): Promise<A2ANotification | null> {
		if (!this.started || !this.listenerClient) {
			await this.start();
		}

		return new Promise((resolve) => {
			let resolved = false;

			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					this.listenerClient?.removeListener("notification", handler);
					resolve(null);
				}
			}, waitMs);

			const handler = (msg: any) => {
				if (msg.channel === this.pgChannel && !resolved) {
					resolved = true;
					clearTimeout(timeout);
					this.listenerClient?.removeListener("notification", handler);
					try {
						resolve(JSON.parse(msg.payload));
					} catch {
						resolve(null);
					}
				}
			};

			this.listenerClient.on("notification", handler);
		});
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
	async listSubscriptions(args: {
		agent_identity?: string;
	}): Promise<CallToolResult> {
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
					{
						type: "text",
						text: `## Channel Subscriptions\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list subscriptions", err);
		}
	}

	// -------------------------------------------------------------------------
	// Core Messaging (enhanced for P149)
	// -------------------------------------------------------------------------

	// P1105 AC-5: write rejected bearer events to operator_audit_log
	private async _logAuthRejection(fromAgent: string, reason: string): Promise<void> {
		try {
			await query(
				`INSERT INTO roadmap.operator_audit_log
				   (operator_name, action, decision, target_kind, target_identity, request_summary, failure_reason)
				 VALUES ('system', 'msg_send', 'deny', 'user', $1, '{}', $2)`,
				[fromAgent, `bearer:${reason}`],
			);
		} catch {
			// audit log failures must never block the response
		}
	}

	async sendMessage(args: {
		from_agent: string;
		to_agent?: string;
		channel?: string;
		message_content: string;
		message_type?: string;
		proposal_id?: string;
		correlation_id?: string;
		_signature?: string; // P159: optional hex-encoded Ed25519 signature
	}): Promise<CallToolResult> {
		try {
			// P159 AC-5: Soft-fail identity verification for all agents (not just user/*)
			// Signature and data are optional; unsigned requests are logged but allowed
			const { verifyAgentIdentity } = await import("../../../core/identity/identity-verification.ts");
			const verification = await verifyAgentIdentity(
				args.from_agent,
				args._signature as string | undefined,
				args.message_content, // Sign over message content
			);

			// In hard-fail mode (AGENTHIVE_AUTH_REQUIRED=true), reject if verification.rejected
			if (verification.rejected) {
				const httpStatus = verification.reason === "public_key_not_found" ? 401 : 403;
				return {
					content: [{ type: "text", text: `⛔ [P159] Identity verification failed (${verification.reason}). HTTP ${httpStatus}.` }],
				};
			}

			// P1105 AC-3: USER senders must carry a valid bearer token whose sub matches from_agent.
			if (args.from_agent?.startsWith("user/")) {
				const ctx = agentContextStorage.getStore();
				if (!ctx?.verified) {
					await this._logAuthRejection(args.from_agent, "missing_bearer_token");
					return {
						content: [{ type: "text", text: "⛔ 401 Unauthorized: Bearer token required for user/* senders." }],
					};
				}
				if (ctx.verified.principal_id !== args.from_agent) {
					await this._logAuthRejection(args.from_agent, "sub_mismatch");
					return {
						content: [{ type: "text", text: `⛔ 403 Forbidden: Token sub '${ctx.verified.principal_id}' does not match from_agent '${args.from_agent}'.` }],
					};
				}
			}

			// AC#2: Enforce ACL before inserting. DMs require an explicit grant;
			// channel posts require a channel_post grant.
			const grantType = args.to_agent ? "dm" : "channel_post";
			const aclResult = await checkMessageACL(
				args.from_agent,
				args.to_agent ?? null,
				grantType,
			);
			if (!aclResult.allowed) {
				return {
					content: [
						{
							type: "text",
							text: `⛔ Delivery denied (AC#2): ${aclResult.reason}`,
						},
					],
				};
			}

			const { rows } = await query(
				`INSERT INTO roadmap.message_ledger
                    (from_agent, to_agent, channel, message_content, message_type, proposal_id, correlation_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id, nonce, created_at`,
				[
					args.from_agent,
					args.to_agent || null,
					args.channel || null,
					args.message_content,
					args.message_type || "text",
					args.proposal_id || null,
					args.correlation_id || null,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: `Message sent (id: ${rows[0].id}, nonce: ${rows[0].nonce}) at ${rows[0].created_at}`,
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
	 * Read messages with optional wait_ms for blocking until new messages arrive (AC-4).
	 * When wait_ms > 0, uses pg_notify to block until a notification arrives or timeout.
	 */
	async readMessages(args: {
		agent?: string;
		channel?: string;
		limit?: number;
		wait_ms?: number;
	}): Promise<CallToolResult> {
		try {
			// If wait_ms specified and no messages immediately available, block on pg_notify
			if (args.wait_ms && args.wait_ms > 0) {
				const waitMs = Math.min(Math.max(args.wait_ms, 0), 30000);

				// First, check if messages already exist
				const existing = await this.fetchMessages(args);

				if (firstText(existing) === "No messages found.") {
					// No messages — wait for pg_notify on this agent's dedicated channel (AC#3)
					const listener = new MessageNotificationListener(args.agent);
					try {
						const notification = await listener.waitForMessage(waitMs);
						if (notification) {
							// A notification arrived — re-fetch messages
							return await this.fetchMessages(args);
						}
						// Timeout — return empty
						return {
							content: [
								{
									type: "text",
									text: `No new messages after waiting ${waitMs}ms.`,
								},
							],
						};
					} finally {
						await listener.stop();
					}
				}

				// Messages already exist — return them immediately
				return existing;
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

			const sql = `SELECT DISTINCT channel, COUNT(*) as msg_count${includeMetadata ? ", MAX(created_at) as last_message_at" : ""}
			       FROM message_ledger
			       WHERE channel IS NOT NULL
			       GROUP BY channel${includeMetadata ? "" : ""}
			       ORDER BY channel ASC
			       LIMIT $1`;
			const params: number[] = [limit];

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
