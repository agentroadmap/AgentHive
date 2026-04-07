/**
 * MCP tool schemas for message protocol operations
 */

export const protocolMentionSearchSchema = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			description: "Agent name to search mentions for",
		},
		channel: {
			type: "string",
			description:
				"Channel to search in (optional, searches all if not specified)",
		},
		since: {
			type: "string",
			description: "Only search messages since this timestamp (ISO 8601)",
		},
	},
	required: ["agent"],
};

export const protocolThreadGetSchema = {
	type: "object",
	properties: {
		messageId: {
			type: "string",
			description: "Message ID to get the thread for",
		},
		channel: {
			type: "string",
			description: "Channel containing the message",
		},
	},
	required: ["messageId", "channel"],
};

export const protocolThreadListSchema = {
	type: "object",
	properties: {
		channel: {
			type: "string",
			description: "Channel to list threads from",
		},
		limit: {
			type: "number",
			description: "Maximum number of threads to return",
		},
	},
	required: ["channel"],
};

export const protocolThreadReplySchema = {
	type: "object",
	properties: {
		from: {
			type: "string",
			description: "Sender name",
		},
		channel: {
			type: "string",
			description: "Channel to reply in",
		},
		threadId: {
			type: "string",
			description: "Thread ID (parent message ID) to reply to",
		},
		content: {
			type: "string",
			description: "Reply content",
		},
		priority: {
			type: "string",
			enum: ["low", "normal", "high", "urgent"],
			description: "Message priority",
		},
	},
	required: ["from", "channel", "threadId", "content"],
};

export const protocolSendWithMentionSchema = {
	type: "object",
	properties: {
		from: {
			type: "string",
			description: "Sender name",
		},
		channel: {
			type: "string",
			description: "Channel to send to",
		},
		content: {
			type: "string",
			description: "Message content (use @agent to mention)",
		},
		mentions: {
			type: "array",
			items: { type: "string" },
			description: "List of agent names to mention",
		},
		priority: {
			type: "string",
			enum: ["low", "normal", "high", "urgent"],
			description: "Message priority",
		},
		replyTo: {
			type: "string",
			description: "Message ID to reply to (creates thread if not specified)",
		},
	},
	required: ["from", "channel", "content"],
};

export const protocolNotificationsSchema = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			description: "Agent name to get notifications for",
		},
		channel: {
			type: "string",
			description: "Specific channel to check (optional)",
		},
		since: {
			type: "string",
			description: "Only get notifications since this timestamp (ISO 8601)",
		},
	},
	required: ["agent"],
};
