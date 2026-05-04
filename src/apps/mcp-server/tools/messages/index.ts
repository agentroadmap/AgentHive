import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { PgMessagingHandlers } from "./pg-handlers.ts";
import { handleMsgAck } from "./msg-ack.ts";
import { handleMsgReply } from "./msg-reply.ts";
import { handleMsgWaitReply } from "./msg-wait-reply.ts";

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

	const msgAckTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_ack",
			description:
				"Acknowledge a message with outcome (ok|reject|noop). Idempotent — if already acked, returns existing outcome. Cancels pending timeout escalation.",
			inputSchema: {
				type: "object",
				properties: {
					message_id: {
						type: "number",
						description: "Message ID to acknowledge",
					},
					outcome: {
						type: "string",
						enum: ["ok", "reject", "noop"],
						description: "ACK outcome",
					},
					reason: {
						type: "string",
						description: "Optional reason for the outcome",
					},
				},
				required: ["message_id", "outcome"],
			},
		},
		{
			type: "object",
			properties: {
				message_id: { type: "number" },
				outcome: { type: "string" },
				reason: { type: "string" },
			},
			required: ["message_id", "outcome"],
		} as JsonSchema,
		async (input) =>
			handleMsgAck(input as {
				message_id: number;
				outcome: "ok" | "reject" | "noop";
				reason?: string;
			}),
	);

	const msgReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_reply",
			description:
				"Reply to a message using correlation_id. Auto-acks the original message and notifies recipient via pg_notify.",
			inputSchema: {
				type: "object",
				properties: {
					correlation_id: {
						type: "string",
						description: "UUID correlation_id of the original message to reply to",
					},
					content: {
						type: "string",
						description: "Reply message content",
					},
					message_type: {
						type: "string",
						description: "Reply message type (defaults to 'ack')",
					},
					from_agent: {
						type: "string",
						description: "Agent identity sending the reply",
					},
				},
				required: ["correlation_id", "content", "from_agent"],
			},
		},
		{
			type: "object",
			properties: {
				correlation_id: { type: "string" },
				content: { type: "string" },
				message_type: { type: "string" },
				from_agent: { type: "string" },
			},
			required: ["correlation_id", "content", "from_agent"],
		} as JsonSchema,
		async (input) =>
			handleMsgReply(input as {
				correlation_id: string;
				content: string;
				message_type?: string;
				from_agent: string;
			}),
	);

	const msgWaitReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_wait_reply",
			description:
				"Wait for a reply to a message using correlation_id. Polls every 5s with pg_notify fallback. Returns reply_message_id if a reply arrives, or timed_out: true if timeout exceeded.",
			inputSchema: {
				type: "object",
				properties: {
					message_id: {
						type: "number",
						description: "Original message ID to wait for a reply to",
					},
					timeout_ms: {
						type: "number",
						description: "Timeout in milliseconds (0-300000, capped at 5 minutes)",
					},
					agent: {
						type: "string",
						description: "Agent identity waiting for the reply",
					},
				},
				required: ["message_id", "timeout_ms", "agent"],
			},
		},
		{
			type: "object",
			properties: {
				message_id: { type: "number" },
				timeout_ms: { type: "number" },
				agent: { type: "string" },
			},
			required: ["message_id", "timeout_ms", "agent"],
		} as JsonSchema,
		async (input) =>
			handleMsgWaitReply(input as {
				message_id: number;
				timeout_ms: number;
				agent: string;
			}),
	);

	server.addTool(sendTool);
	server.addTool(readTool);
	server.addTool(markReadTool);
	server.addTool(unreadCountTool);
	server.addTool(chanListTool);
	server.addTool(chanSubscribeTool);
	server.addTool(msgAckTool);
	server.addTool(msgReplyTool);
	server.addTool(msgWaitReplyTool);
}
