/**
 * MCP tools for inter-agent communication protocol
 *
 * STATE-49: Inter-Agent Communication Protocol
 * AC#3: Agent mentions trigger notifications
 * AC#4: Message threading supported
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { ProtocolHandlers } from "./handlers.ts";
import {
	protocolMentionSearchSchema,
	protocolNotificationsSchema,
	protocolSendWithMentionSchema,
	protocolThreadGetSchema,
	protocolThreadListSchema,
	protocolThreadReplySchema,
} from "./schemas.ts";

export function registerProtocolTools(server: McpServer): void {
	const handlers = new ProtocolHandlers(server);

	// AC#3: Mention search tool
	const mentionSearchTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_mention_search",
			description: "Search for mentions of an agent across channels",
			inputSchema: protocolMentionSearchSchema,
		},
		protocolMentionSearchSchema,
		async (input) => handlers.searchMentions(input as any),
	);

	// AC#4: Get specific thread
	const threadGetTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_get",
			description: "Get a specific thread with all replies",
			inputSchema: protocolThreadGetSchema,
		},
		protocolThreadGetSchema,
		async (input) => handlers.getThread(input as any),
	);

	// AC#4: List threads
	const threadListTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_list",
			description: "List all threads in a channel",
			inputSchema: protocolThreadListSchema,
		},
		protocolThreadListSchema,
		async (input) => handlers.listThreads(input as any),
	);

	// AC#4: Reply to thread
	const threadReplyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "protocol_thread_reply",
			description: "Reply to an existing thread",
			inputSchema: protocolThreadReplySchema,
		},
		protocolThreadReplySchema,
		async (input) => handlers.replyToThread(input as any),
	);

	// AC#3: Send with mentions
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

	// AC#3: Get notifications
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
}
