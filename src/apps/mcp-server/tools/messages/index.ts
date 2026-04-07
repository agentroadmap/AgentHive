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

export function registerMessageTools(server: McpServer): void {
	const handlers = new MessageHandlers(server);

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
}
