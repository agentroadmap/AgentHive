import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { PgMessagingHandlers } from "./pg-handlers.ts";

const msgMarkReadSchema: JsonSchema = {
	type: "object",
	properties: {
		message_id: {
			type: "number",
			description: "Message ID to mark as read",
		},
		agent: {
			type: "string",
			description: "Agent identity (recipient)",
		},
	},
	required: ["message_id", "agent"],
};

const msgUnreadCountSchema: JsonSchema = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			description: "Agent identity to check unread count for",
		},
	},
	required: ["agent"],
};

export function registerMessageTools(server: McpServer): void {
	const pgHandlers = new PgMessagingHandlers(server, process.cwd());

	const sendTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_send",
			description:
				"Send a message to the Postgres message_ledger. Trust gate enforced on send — restricted/blocked senders are silently dropped.",
			inputSchema: {
				type: "object",
				properties: {
					from_agent: { type: "string" },
					to_agent: { type: "string" },
					channel: { type: "string" },
					message_content: { type: "string" },
					message_type: {
						type: "string",
						enum: ["task", "notify", "ack", "error", "event", "text"],
					},
					proposal_id: { type: "string" },
				},
				required: ["from_agent", "message_content"],
			},
		},
		{
			type: "object",
			properties: {
				from_agent: { type: "string" },
				to_agent: { type: "string" },
				channel: { type: "string" },
				message_content: { type: "string" },
				message_type: { type: "string" },
				proposal_id: { type: "string" },
			},
			required: ["from_agent", "message_content"],
		} as JsonSchema,
		async (input) =>
			pgHandlers.sendMessage(input as {
				from_agent: string;
				to_agent?: string;
				channel?: string;
				message_content: string;
				message_type?: string;
				proposal_id?: string;
			}),
	);

	const readTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_read",
			description:
				"Read messages from the Postgres message_ledger. With agent + wait_ms, blocks on pg_notify channel `a2a_msg_{agent}` until a new message arrives or timeout expires (migration 096). Trust-filtered: restricted/blocked senders are excluded.",
			inputSchema: {
				type: "object",
				properties: {
					agent: {
						type: "string",
						description: "Filter by agent identity (required for wait_ms blocking reads)",
					},
					channel: { type: "string", description: "Filter by channel name" },
					limit: { type: "number", description: "Max messages to return (default 50)" },
					wait_ms: {
						type: "number",
						description:
							"Block up to N ms waiting for a new DM via pg_notify (0–30000). Requires agent. Returns immediately if messages already exist.",
					},
				},
			},
		},
		{
			type: "object",
			properties: {
				agent: { type: "string" },
				channel: { type: "string" },
				limit: { type: "number" },
				wait_ms: { type: "number" },
			},
		} as JsonSchema,
		async (input) =>
			pgHandlers.readMessages(input as {
				agent?: string;
				channel?: string;
				limit?: number;
				wait_ms?: number;
			}),
	);

	const markReadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_mark_read",
			description: "Mark a Postgres message as read. Sets read_at timestamp.",
			inputSchema: msgMarkReadSchema,
		},
		msgMarkReadSchema,
		async (input) =>
			pgHandlers.markRead(input as { message_id: number; agent: string }),
	);

	const unreadCountTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_unread_count",
			description: "Get unread message count for an agent from message_ledger.",
			inputSchema: msgUnreadCountSchema,
		},
		msgUnreadCountSchema,
		async (input) => pgHandlers.unreadCount(input as { agent: string }),
	);

	const chanListTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_list",
			description: "List channels with message counts from the Postgres message_ledger.",
			inputSchema: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Maximum channels to return (default 50, max 500)",
					},
					include_metadata: {
						type: "boolean",
						description: "Include last_message_at metadata. Default false.",
					},
				},
				required: [],
			},
		},
		{
			type: "object",
			properties: {
				limit: { type: "number" },
				include_metadata: { type: "boolean" },
			},
		} as JsonSchema,
		async (input) =>
			pgHandlers.listChannels(input as { limit?: number; include_metadata?: boolean }),
	);

	const chanSubscribeTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_subscribe",
			description:
				"Subscribe or unsubscribe from a channel. Persisted in channel_subscription table for pg_notify delivery.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Agent identity for the subscription.",
					},
					channel: {
						type: "string",
						description: "Channel name (direct, team:<name>, broadcast, system).",
					},
					subscribe: {
						type: "boolean",
						description: "True to subscribe, false to unsubscribe. Defaults to true.",
					},
				},
				required: ["agent_identity", "channel"],
			},
		},
		{
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				channel: { type: "string" },
				subscribe: { type: "boolean" },
			},
			required: ["agent_identity", "channel"],
		} as JsonSchema,
		async (input) =>
			pgHandlers.subscribe(input as { agent_identity: string; channel: string; subscribe?: boolean }),
	);

	server.addTool(sendTool);
	server.addTool(readTool);
	server.addTool(markReadTool);
	server.addTool(unreadCountTool);
	server.addTool(chanListTool);
	server.addTool(chanSubscribeTool);
}
