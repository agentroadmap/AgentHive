/**
 * Postgres-backed Protocol MCP Tools for AgentHive (P067).
 *
 * Implements threaded discussions with @-mentions, all backed by Postgres.
 * Thread replies maintain insertion order via sequence column.
 * Mentions link agents to proposals/threads with notification support.
 */

import { randomUUID } from "node:crypto";
import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

interface ThreadRow {
	id: number;
	thread_id: string;
	channel: string;
	proposal_id: number | null;
	root_message: string;
	root_author: string;
	reply_count: number;
	created_at: string | Date;
	last_activity: string | Date;
}

interface ReplyRow {
	id: number;
	thread_id: string;
	seq: number;
	author: string;
	content: string;
	created_at: string | Date;
}

interface MentionRow {
	id: number;
	mentioned_agent: string;
	mentioned_by: string;
	proposal_id: number | null;
	thread_id: string | null;
	context: string | null;
	created_at: string | Date;
	read_at: string | Date | null;
}

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

function formatTimestamp(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export class PgProtocolHandlers {
	/**
	 * Create a new thread (root message) in a channel.
	 */
	async createThread(args: {
		channel: string;
		author: string;
		content: string;
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
			const threadId = `thread-${randomUUID().slice(0, 8)}`;

			// Validate proposal_id if provided
			let proposalId: number | null = null;
			if (args.proposal_id) {
				const { rows } = await query<{ id: number }>(
					`SELECT id FROM roadmap.proposal WHERE display_id = $1 OR CAST(id AS text) = $1 LIMIT 1`,
					[args.proposal_id],
				);
				if (rows.length > 0) {
					proposalId = rows[0].id;
				}
			}

			const { rows } = await query<ThreadRow>(
				`INSERT INTO roadmap.protocol_threads (thread_id, channel, proposal_id, root_message, root_author)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id, thread_id, channel, proposal_id, root_message, root_author, reply_count, created_at, last_activity`,
				[threadId, args.channel, proposalId, args.content, args.author],
			);

			const thread = rows[0];

			// Extract and process @-mentions from content
			const mentionedAgents = this.extractMentions(args.content);
			for (const agent of mentionedAgents) {
				await query(
					`INSERT INTO roadmap.mentions (mentioned_agent, mentioned_by, proposal_id, thread_id, context)
					 VALUES ($1, $2, $3, $4, $5)`,
					[agent, args.author, proposalId, threadId, args.content.substring(0, 200)],
				);
			}

			let mentionNote = "";
			if (mentionedAgents.length > 0) {
				mentionNote = `\nMentioned: ${mentionedAgents.join(", ")}`;
			}

			return {
				content: [
					{
						type: "text",
						text: `Thread ${threadId} created in #${args.channel} by ${args.author}${mentionNote}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to create thread", err);
		}
	}

	/**
	 * Reply to a thread with insertion-order guarantee (AC-9, AC-16).
	 */
	async replyToThread(args: {
		thread_id: string;
		author: string;
		content: string;
	}): Promise<CallToolResult> {
		try {
			// Verify thread exists
			const { rows: threads } = await query<ThreadRow>(
				`SELECT thread_id FROM roadmap.protocol_threads WHERE thread_id = $1`,
				[args.thread_id],
			);

			if (threads.length === 0) {
				return {
					content: [{ type: "text", text: `Thread ${args.thread_id} not found.` }],
				};
			}

			// Get next sequence number
			const { rows: seqRows } = await query<{ max_seq: number }>(
				`SELECT COALESCE(MAX(seq), 0) as max_seq FROM roadmap.protocol_replies WHERE thread_id = $1`,
				[args.thread_id],
			);

			const nextSeq = (seqRows[0]?.max_seq ?? 0) + 1;

			const { rows } = await query<ReplyRow>(
				`INSERT INTO roadmap.protocol_replies (thread_id, seq, author, content)
				 VALUES ($1, $2, $3, $4)
				 RETURNING id, thread_id, seq, author, content, created_at`,
				[args.thread_id, nextSeq, args.author, args.content],
			);

			const reply = rows[0];

			// Extract and process @-mentions
			const mentionedAgents = this.extractMentions(args.content);
			for (const agent of mentionedAgents) {
				await query(
					`INSERT INTO roadmap.mentions (mentioned_agent, mentioned_by, thread_id, context)
					 VALUES ($1, $2, $3, $4)`,
					[agent, args.author, args.thread_id, args.content.substring(0, 200)],
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `Reply #${reply.seq} sent to thread ${args.thread_id} by ${args.author}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to reply to thread", err);
		}
	}

	/**
	 * Get a thread with its replies (paginated, max 100 per call) (AC-12, AC-16).
	 */
	async getThread(args: {
		thread_id: string;
		cursor?: number;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(args.limit || 100, 100);
			const cursor = args.cursor || 0;

			// Get thread
			const { rows: threads } = await query<ThreadRow>(
				`SELECT id, thread_id, channel, proposal_id, root_message, root_author, reply_count, created_at, last_activity
				 FROM roadmap.protocol_threads
				 WHERE thread_id = $1`,
				[args.thread_id],
			);

			if (threads.length === 0) {
				return {
					content: [{ type: "text", text: `Thread ${args.thread_id} not found.` }],
				};
			}

			const thread = threads[0];

			// Get replies (paginated)
			const { rows: replies } = await query<ReplyRow>(
				`SELECT id, thread_id, seq, author, content, created_at
				 FROM roadmap.protocol_replies
				 WHERE thread_id = $1 AND seq > $2
				 ORDER BY seq ASC
				 LIMIT $3`,
				[args.thread_id, cursor, limit],
			);

			const lines = [
				`## Thread: ${args.thread_id} in #${thread.channel}`,
				`**Root:** ${thread.root_author}: ${thread.root_message}`,
				`**Replies:** ${thread.reply_count} (showing ${replies.length} from seq ${cursor})`,
				`**Created:** ${formatTimestamp(thread.created_at)} | **Last activity:** ${formatTimestamp(thread.last_activity)}`,
				"",
			];

			for (const reply of replies) {
				lines.push(`  #${reply.seq} ${reply.author} — ${formatTimestamp(reply.created_at)}`);
				lines.push(`  ${reply.content}`);
				lines.push("");
			}

			// Pagination cursor
			if (replies.length === limit) {
				const nextCursor = replies[replies.length - 1].seq;
				lines.push(`--- More replies available. Use cursor: ${nextCursor}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (err) {
			return errorResult("Failed to get thread", err);
		}
	}

	/**
	 * List threads in a channel, sorted by last activity.
	 */
	async listThreads(args: {
		channel: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const limit = args.limit || 20;

			const { rows } = await query<ThreadRow>(
				`SELECT id, thread_id, channel, proposal_id, root_message, root_author, reply_count, created_at, last_activity
				 FROM roadmap.protocol_threads
				 WHERE channel = $1
				 ORDER BY last_activity DESC
				 LIMIT $2`,
				[args.channel, limit],
			);

			if (rows.length === 0) {
				return {
					content: [{ type: "text", text: `No threads found in #${args.channel}.` }],
				};
			}

			const lines = [`## Threads in #${args.channel} (${rows.length} total)`];
			for (const thread of rows) {
				lines.push("");
				lines.push(`### ${thread.thread_id}`);
				lines.push(`- **${thread.root_author}**: ${thread.root_message.substring(0, 80)}${thread.root_message.length > 80 ? "..." : ""}`);
				lines.push(`- Replies: ${thread.reply_count}`);
				lines.push(`- Last activity: ${formatTimestamp(thread.last_activity)}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (err) {
			return errorResult("Failed to list threads", err);
		}
	}

	/**
	 * Send a message with @-mentions (AC-8).
	 */
	async sendMention(args: {
		mentioned_agent: string;
		mentioned_by: string;
		proposal_id?: string;
		thread_id?: string;
		context?: string;
	}): Promise<CallToolResult> {
		try {
			let proposalId: number | null = null;
			if (args.proposal_id) {
				const { rows } = await query<{ id: number }>(
					`SELECT id FROM roadmap.proposal WHERE display_id = $1 OR CAST(id AS text) = $1 LIMIT 1`,
					[args.proposal_id],
				);
				if (rows.length > 0) {
					proposalId = rows[0].id;
				}
			}

			const { rows } = await query<MentionRow>(
				`INSERT INTO roadmap.mentions (mentioned_agent, mentioned_by, proposal_id, thread_id, context)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id, mentioned_agent, mentioned_by, created_at`,
				[
					args.mentioned_agent,
					args.mentioned_by,
					proposalId,
					args.thread_id || null,
					args.context || null,
				],
			);

			return {
				content: [
					{
						type: "text",
						text: `Mention #${rows[0].id}: @${args.mentioned_agent} mentioned by ${args.mentioned_by}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to send mention", err);
		}
	}

	/**
	 * Search for mentions of an agent (AC-8).
	 */
	async searchMentions(args: {
		agent: string;
		since?: string;
	}): Promise<CallToolResult> {
		try {
			const params: unknown[] = [args.agent];
			let sinceClause = "";
			if (args.since) {
				sinceClause = " AND created_at >= $2";
				params.push(args.since);
			}

			const { rows } = await query<MentionRow>(
				`SELECT id, mentioned_agent, mentioned_by, proposal_id, thread_id, context, created_at, read_at
				 FROM roadmap.mentions
				 WHERE mentioned_agent = $1${sinceClause}
				 ORDER BY created_at DESC
				 LIMIT 100`,
				params,
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No mentions found for @${args.agent}${args.since ? ` since ${args.since}` : ""}.`,
						},
					],
				};
			}

			const lines = [`## Mentions for @${args.agent} (${rows.length})`];
			for (const mention of rows) {
				const unread = mention.read_at ? "" : " 🔴";
				const proposal = mention.proposal_id ? ` [proposal ${mention.proposal_id}]` : "";
				const thread = mention.thread_id ? ` [thread ${mention.thread_id}]` : "";
				lines.push(
					`- [${formatTimestamp(mention.created_at)}] by @${mention.mentioned_by}${proposal}${thread}${unread}`,
				);
				if (mention.context) {
					lines.push(`  ${mention.context.substring(0, 100)}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (err) {
			return errorResult("Failed to search mentions", err);
		}
	}

	/**
	 * Get notifications (mentions) for an agent, with read/unread grouping (AC-8).
	 */
	async getNotifications(args: {
		agent: string;
		since?: string;
	}): Promise<CallToolResult> {
		try {
			const params: unknown[] = [args.agent];
			let sinceClause = "";
			if (args.since) {
				sinceClause = " AND created_at >= $2";
				params.push(args.since);
			}

			const { rows } = await query<MentionRow>(
				`SELECT id, mentioned_agent, mentioned_by, proposal_id, thread_id, context, created_at, read_at
				 FROM roadmap.mentions
				 WHERE mentioned_agent = $1${sinceClause}
				 ORDER BY created_at DESC
				 LIMIT 100`,
				params,
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No notifications for @${args.agent}${args.since ? ` since ${args.since}` : ""}.`,
						},
					],
				};
			}

			const unread = rows.filter((r) => !r.read_at);
			const read = rows.filter((r) => r.read_at);

			const lines = [`## Notifications for @${args.agent}`, `Total: ${rows.length} (${unread.length} unread)\n`];

			if (unread.length > 0) {
				lines.push(`### 🔴 Unread (${unread.length})`);
				for (const n of unread) {
					const proposal = n.proposal_id ? ` [P${n.proposal_id}]` : "";
					lines.push(`- [${formatTimestamp(n.created_at)}] **@${n.mentioned_by}**${proposal}: ${n.context?.substring(0, 80) ?? "mentioned you"}`);
				}
				lines.push("");
			}

			if (read.length > 0) {
				lines.push(`### ✅ Read (${read.length})`);
				for (const n of read) {
					const proposal = n.proposal_id ? ` [P${n.proposal_id}]` : "";
					lines.push(`- [${formatTimestamp(n.created_at)}] @${n.mentioned_by}${proposal}`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (err) {
			return errorResult("Failed to get notifications", err);
		}
	}

	/**
	 * Mark a mention as read.
	 */
	async markMentionRead(args: {
		mention_id: number;
		agent: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`UPDATE roadmap.mentions
				 SET read_at = now()
				 WHERE id = $1 AND mentioned_agent = $2 AND read_at IS NULL
				 RETURNING id, read_at`,
				[args.mention_id, args.agent],
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Mention ${args.mention_id} not found or already read.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Mention ${args.mention_id} marked as read.`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to mark mention as read", err);
		}
	}

	/**
	 * Extract @mentions from text content.
	 */
	private extractMentions(content: string): string[] {
		const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
		const mentioned: string[] = [];
		let match: RegExpExecArray | null = mentionRegex.exec(content);
		while (match !== null) {
			if (!mentioned.includes(match[1])) {
				mentioned.push(match[1]);
			}
			match = mentionRegex.exec(content);
		}
		return mentioned;
	}
}
