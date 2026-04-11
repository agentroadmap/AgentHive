/**
 * MCP tools for inter-agent communication protocol
 *
 * STATE-49: Inter-Agent Communication Protocol
 * AC#3: Agent mentions trigger notifications
 * AC#4: Message threading supported
 *
 * P067: Added Postgres-backed tools (protocol_pg_*) for threads, replies, and mentions.
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { ProtocolHandlers } from "./handlers.ts";
import { PgProtocolHandlers } from "./pg-handlers.ts";
import {
	protocolMentionSearchSchema,
	protocolNotificationsSchema,
	protocolSendWithMentionSchema,
	protocolThreadGetSchema,
	protocolThreadListSchema,
	protocolThreadReplySchema,
} from "./schemas.ts";

// ─── Postgres schemas ────────────────────────────────────────────────────────
const pgCreateThreadSchema = {
	type: "object",
	properties: {
		channel: { type: "string", description: "Channel name for the thread" },
		author: { type: "string", description: "Author agent identity" },
		content: { type: "string", description: "Root message content" },
		proposal_id: { type: "string", description: "Optional proposal ID to link" },
	},
	required: ["channel", "author", "content"],
	additionalProperties: false,
};

const pgReplyThreadSchema = {
	type: "object",
	properties: {
		thread_id: { type: "string", description: "Thread ID to reply to" },
		author: { type: "string", description: "Author agent identity" },
		content: { type: "string", description: "Reply content" },
	},
	required: ["thread_id", "author", "content"],
	additionalProperties: false,
};

const pgGetThreadSchema = {
	type: "object",
	properties: {
		thread_id: { type: "string", description: "Thread ID" },
		cursor: { type: "number", description: "Sequence cursor for pagination" },
		limit: { type: "number", minimum: 1, maximum: 100, description: "Max replies (default 100)" },
	},
	required: ["thread_id"],
	additionalProperties: false,
};

const pgListThreadsSchema = {
	type: "object",
	properties: {
		channel: { type: "string", description: "Channel to list threads from" },
		limit: { type: "number", minimum: 1, maximum: 100, description: "Max threads (default 20)" },
	},
	required: ["channel"],
	additionalProperties: false,
};

const pgSendMentionSchema = {
	type: "object",
	properties: {
		mentioned_agent: { type: "string", description: "Agent being mentioned" },
		mentioned_by: { type: "string", description: "Agent sending the mention" },
		proposal_id: { type: "string", description: "Optional proposal context" },
		thread_id: { type: "string", description: "Optional thread context" },
		context: { type: "string", description: "Optional context message" },
	},
	required: ["mentioned_agent", "mentioned_by"],
	additionalProperties: false,
};

const pgSearchMentionsSchema = {
	type: "object",
	properties: {
		agent: { type: "string", description: "Agent to search mentions for" },
		since: { type: "string", description: "ISO 8601 timestamp filter" },
	},
	required: ["agent"],
	additionalProperties: false,
};

const pgNotificationsSchema = {
	type: "object",
	properties: {
		agent: { type: "string", description: "Agent to get notifications for" },
		since: { type: "string", description: "ISO 8601 timestamp filter" },
	},
	required: ["agent"],
	additionalProperties: false,
};

const pgMarkReadSchema = {
	type: "object",
	properties: {
		mention_id: { type: "number", description: "Mention ID to mark as read" },
		agent: { type: "string", description: "Agent identity" },
	},
	required: ["mention_id", "agent"],
	additionalProperties: false,
};

export function registerProtocolTools(server: McpServer): void {
	const handlers = new ProtocolHandlers(server);
	const pgHandlers = new PgProtocolHandlers();

	// ─── Filesystem-backed tools (legacy) ────────────────────────────────
	const mentionSearchTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_mention_search",
			description: "Search for mentions of an agent across channels",
			inputSchema: protocolMentionSearchSchema,
		},
		protocolMentionSearchSchema,
		async (input) => handlers.searchMentions(input as any),
	);

	const threadGetTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_get",
			description: "Get a specific thread with all replies",
			inputSchema: protocolThreadGetSchema,
		},
		protocolThreadGetSchema,
		async (input) => handlers.getThread(input as any),
	);

	const threadListTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_list",
			description: "List all threads in a channel",
			inputSchema: protocolThreadListSchema,
		},
		protocolThreadListSchema,
		async (input) => handlers.listThreads(input as any),
	);

	const threadReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_reply",
			description: "Reply to an existing thread",
			inputSchema: protocolThreadReplySchema,
		},
		protocolThreadReplySchema,
		async (input) => handlers.replyToThread(input as any),
	);

	const sendWithMentionTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_send_mention",
			description:
				"Send a message with agent mentions (triggers notifications)",
			inputSchema: protocolSendWithMentionSchema,
		},
		protocolSendWithMentionSchema,
		async (input) => handlers.sendWithMentions(input as any),
	);

	const notificationsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_notifications",
			description: "Get all notifications (mentions) for an agent",
			inputSchema: protocolNotificationsSchema,
		},
		protocolNotificationsSchema,
		async (input) => handlers.getNotifications(input as any),
	);

	server.addTool(mentionSearchTool);
	server.addTool(threadGetTool);
	server.addTool(threadListTool);
	server.addTool(threadReplyTool);
	server.addTool(sendWithMentionTool);
	server.addTool(notificationsTool);

	// ─── Postgres-backed tools (P067) ────────────────────────────────────
	const pgCreateThreadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_create_thread",
			description:
				"Create a new threaded discussion in Postgres with @-mention processing and optional proposal link",
			inputSchema: pgCreateThreadSchema,
		},
		pgCreateThreadSchema,
		async (input) =>
			pgHandlers.createThread(input as {
				channel: string;
				author: string;
				content: string;
				proposal_id?: string;
			}),
	);

	const pgReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_reply",
			description:
				"Reply to a Postgres thread with insertion-order guarantee and @-mention processing",
			inputSchema: pgReplyThreadSchema,
		},
		pgReplyThreadSchema,
		async (input) =>
			pgHandlers.replyToThread(input as {
				thread_id: string;
				author: string;
				content: string;
			}),
	);

	const pgGetThreadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_get_thread",
			description:
				"Get a Postgres thread with paginated replies (max 100 per call). Use cursor for continuation.",
			inputSchema: pgGetThreadSchema,
		},
		pgGetThreadSchema,
		async (input) =>
			pgHandlers.getThread(input as {
				thread_id: string;
				cursor?: number;
				limit?: number;
			}),
	);

	const pgListThreadsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_list_threads",
			description: "List Postgres threads in a channel, sorted by last activity",
			inputSchema: pgListThreadsSchema,
		},
		pgListThreadsSchema,
		async (input) =>
			pgHandlers.listThreads(input as { channel: string; limit?: number }),
	);

	const pgSendMentionTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_send_mention",
			description:
				"Create a @-mention record in Postgres linking an agent to a proposal or thread",
			inputSchema: pgSendMentionSchema,
		},
		pgSendMentionSchema,
		async (input) =>
			pgHandlers.sendMention(input as {
				mentioned_agent: string;
				mentioned_by: string;
				proposal_id?: string;
				thread_id?: string;
				context?: string;
			}),
	);

	const pgSearchMentionsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_search_mentions",
			description: "Search Postgres mentions for an agent with optional time filter",
			inputSchema: pgSearchMentionsSchema,
		},
		pgSearchMentionsSchema,
		async (input) =>
			pgHandlers.searchMentions(input as { agent: string; since?: string }),
	);

	const pgNotificationsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_notifications",
			description:
				"Get Postgres notifications for an agent with read/unread grouping",
			inputSchema: pgNotificationsSchema,
		},
		pgNotificationsSchema,
		async (input) =>
			pgHandlers.getNotifications(input as { agent: string; since?: string }),
	);

	const pgMarkReadTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_pg_mark_read",
			description: "Mark a Postgres mention as read",
			inputSchema: pgMarkReadSchema,
		},
		pgMarkReadSchema,
		async (input) =>
			pgHandlers.markMentionRead(input as { mention_id: number; agent: string }),
	);

	server.addTool(pgCreateThreadTool);
	server.addTool(pgReplyTool);
	server.addTool(pgGetThreadTool);
	server.addTool(pgListThreadsTool);
	server.addTool(pgSendMentionTool);
	server.addTool(pgSearchMentionsTool);
	server.addTool(pgNotificationsTool);
	server.addTool(pgMarkReadTool);
}
