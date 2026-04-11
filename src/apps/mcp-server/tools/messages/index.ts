import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import type {
	MessageChannelsArgs,
	MessageReadArgs,
	MessageSendArgs,
} from "./handlers.ts";
import { MessageHandlers } from "./handlers.ts";
import { PgMessagingHandlers } from "./pg-handlers.ts";

const messageChannelsSchema: JsonSchema = {
	type: "object",
	properties: {},
	required: [],
};

const messageReadSchema: JsonSchema = {
	type: "object",
	properties: {
		channel: {
			type: "string",
			description:
				"Channel name to read from. Use 'public' for the public channel, a group name (e.g. 'project'), or a private channel name (e.g. 'alice-bob').",
		},
		since: {
			type: "string",
			description:
				"ISO 8601 timestamp. Only return messages after this time. Use the timestamp of the last message you read to get only new messages.",
		},
	},
	required: ["channel"],
};

const messageSendSchema: JsonSchema = {
	type: "object",
	properties: {
		from: {
			type: "string",
			description:
				"Your agent name or identity (e.g. 'Gemini', 'Copilot', 'Alice').",
		},
		message: {
			type: "string",
			description: "The message content to send.",
		},
		channel: {
			type: "string",
			description:
				"Group channel name (e.g. 'project') or 'public'. Ignored when 'to' is set.",
		},
		to: {
			type: "string",
			description:
				"Agent name for a private DM (e.g. 'alice' or '@alice'). When set, sends a private message.",
		},
		intent: {
			type: "object",
			description:
				"Structured negotiation intent (claim_request, handoff, reject, accept, block).",
			properties: {
				type: {
					type: "string",
					enum: ["claim_request", "handoff", "reject", "accept", "block"],
					description: "Intent type.",
				},
				proposalId: {
					type: "string",
					description: "Target proposal ID (e.g. 'STATE-9').",
				},
				to: {
					type: "string",
					description: "Target agent for the intent.",
				},
				reason: {
					type: "string",
					description: "Human-readable reason for the intent.",
				},
			},
			required: ["type", "proposalId"],
		},
	},
	required: ["from", "message"],
};

const messageSubscribeSchema: JsonSchema = {
	type: "object",
	properties: {
		channel: {
			type: "string",
			description: "Channel name to subscribe to (e.g. 'public', 'project').",
		},
		from: {
			type: "string",
			description: "Agent identity for the subscription.",
		},
		subscribe: {
			type: "boolean",
			description: "True to subscribe, false to unsubscribe. Defaults to true.",
		},
	},
	required: ["channel", "from"],
};

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
	const handlers = new MessageHandlers(server);
	const pgHandlers = new PgMessagingHandlers(server, process.cwd());

	// ─── Filesystem-backed tools ─────────────────────────────────────────
	const channelsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_list",
			description:
				"List all available chat channels (group chats and private DMs) in this project.",
			inputSchema: messageChannelsSchema,
		},
		messageChannelsSchema,
		async (input) => handlers.listChannels(input as MessageChannelsArgs),
	);

	const readTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_read",
			description:
				"Read messages from a chat channel. Use the 'since' parameter with the last message timestamp to fetch only new messages — this is how you listen for replies.",
			inputSchema: messageReadSchema,
		},
		messageReadSchema,
		async (input) => handlers.readMessages(input as MessageReadArgs),
	);

	const sendTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_send",
			description:
				"Send a message to a group chat channel or a private DM with another agent.",
			inputSchema: messageSendSchema,
		},
		messageSendSchema,
		async (input) => handlers.sendMessage(input as MessageSendArgs),
	);

	const subscribeTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "chan_subscribe",
			description:
				"Subscribe or unsubscribe from a channel to receive push notifications when new messages arrive. Subscriptions persist across sessions.",
			inputSchema: messageSubscribeSchema,
		},
		messageSubscribeSchema,
		async (input) =>
			handlers.subscribe(
				input as { channel: string; from: string; subscribe?: boolean },
			),
	);

	server.addTool(channelsTool);
	server.addTool(readTool);
	server.addTool(sendTool);
	server.addTool(subscribeTool);

	// ─── Postgres-backed tools (P067) ────────────────────────────────────
	const pgSendTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_pg_send",
			description:
				"Send a message to Postgres message_ledger with typed message_type, channel, and optional proposal link",
			inputSchema: {
				type: "object",
				properties: {
					from_agent: { type: "string" },
					to_agent: { type: "string" },
					channel: { type: "string" },
					message_content: { type: "string" },
					message_type: {
						type: "string",
						enum: ["task", "notify", "ack", "error", "event"],
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

	const pgReadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_pg_read",
			description:
				"Read messages from Postgres message_ledger. Supports wait_ms for blocking reads via pg_notify.",
			inputSchema: {
				type: "object",
				properties: {
					agent: { type: "string" },
					channel: { type: "string" },
					limit: { type: "number" },
					wait_ms: { type: "number" },
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

	const pgMarkReadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_pg_mark_read",
			description:
				"Mark a Postgres message as read (AC-7). Sets read_at timestamp and decreases unread count.",
			inputSchema: msgMarkReadSchema,
		},
		msgMarkReadSchema,
		async (input) =>
			pgHandlers.markRead(input as { message_id: number; agent: string }),
	);

	const pgUnreadCountTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "msg_pg_unread_count",
			description:
				"Get unread message count for an agent from Postgres message_ledger (AC-7)",
			inputSchema: msgUnreadCountSchema,
		},
		msgUnreadCountSchema,
		async (input) =>
			pgHandlers.unreadCount(input as { agent: string }),
	);

	server.addTool(pgSendTool);
	server.addTool(pgReadTool);
	server.addTool(pgMarkReadTool);
	server.addTool(pgUnreadCountTool);
}
