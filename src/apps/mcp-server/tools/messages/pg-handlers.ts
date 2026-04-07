/**
 * Postgres-backed Messaging MCP Tools for AgentHive.
 *
 * A2A/A2H communication via the `message_ledger` table.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 */

import { query } from "../../../../postgres/pool.ts";
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

export class PgMessagingHandlers {
	constructor(
		private readonly core: McpServer,
		private readonly projectRoot: string,
	) {}

	async sendMessage(args: {
		from_agent: string;
		to_agent?: string;
		channel?: string;
		message_content: string;
		message_type?: string;
		proposal_id?: string;
	}): Promise<CallToolResult> {
		try {
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

	async readMessages(args: {
		agent?: string;
		channel?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
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
				(r) =>
					`[${r.id}] ${r.from_agent} → ${r.to_agent || r.channel || "broadcast"} (${r.message_type}): ${r.message_content}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to read messages", err);
		}
	}

	async listChannels(_args: {}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`SELECT DISTINCT channel, COUNT(*) as msg_count
         FROM message_ledger
         WHERE channel IS NOT NULL
         GROUP BY channel
         ORDER BY channel ASC`,
			);
			if (!rows.length) {
				return { content: [{ type: "text", text: "No channels found." }] };
			}
			const lines = rows.map((r) => `${r.channel}: ${r.msg_count} messages`);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list channels", err);
		}
	}
}
