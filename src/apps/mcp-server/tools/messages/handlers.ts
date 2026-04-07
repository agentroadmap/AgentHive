import {
	decodeIntent,
	encodeIntent,
	extractHumanText,
	formatIntent,
	type NegotiationIntent,
} from "../../../../shared/types/intents.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export type MessageChannelsArgs = Record<string, never>;

export type MessageReadArgs = {
	channel: string;
	since?: string;
};

export type MessageSendArgs = {
	from: string;
	message: string;
	channel?: string;
	to?: string;
	/** Structured negotiation intent */
	intent?: NegotiationIntent;
};

export class MessageHandlers {
	private readonly core: McpServer;

	constructor(core: McpServer) {
		this.core = core;
	}

	async subscribe(args: {
		channel: string;
		from: string;
		subscribe?: boolean;
	}): Promise<CallToolResult> {
		try {
			const doSubscribe = args.subscribe ?? true;
			if (doSubscribe) {
				await this.core.subscribeToChannel(args.from, args.channel);
				return {
					content: [
						{
							type: "text",
							text: `Subscribed ${args.from} to channel: ${args.channel}`,
						},
					],
				};
			}
			await this.core.unsubscribeFromChannel(args.from, args.channel);
			return {
				content: [
					{
						type: "text",
						text: `Unsubscribed ${args.from} from channel: ${args.channel}`,
					},
				],
			};
		} catch (error) {
			throw new McpError(
				`Failed to subscribe: ${(error as Error).message}`,
				"OPERATION_FAILED",
			);
		}
	}

	async listChannels(_args: MessageChannelsArgs): Promise<CallToolResult> {
		try {
			const channels = await this.core.listChannels();
			if (channels.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "No message channels found. Start chatting with `roadmap talk <message>` to create one.",
						},
					],
				};
			}
			const lines = channels
				.map((c) => `- **${c.name}** (${c.type})`)
				.join("\n");
			return {
				content: [{ type: "text", text: `## Available Channels\n\n${lines}` }],
			};
		} catch (error) {
			throw new McpError(
				`Failed to list channels: ${(error as Error).message}`,
				"OPERATION_FAILED",
			);
		}
	}

	async readMessages(args: MessageReadArgs): Promise<CallToolResult> {
		try {
			const result = await this.core.readMessages({
				channel: args.channel,
				since: args.since,
			});
			if (result.messages.length === 0) {
				const sinceNote = args.since ? ` since ${args.since}` : "";
				return {
					content: [
						{
							type: "text",
							text: `No messages in **#${args.channel}**${sinceNote}.`,
						},
					],
				};
			}

			const lines: string[] = [];
			const intents: Array<{ timestamp: string; intent: NegotiationIntent }> =
				[];

			for (const m of result.messages) {
				const intent = decodeIntent(m.text);
				const humanText = extractHumanText(m.text);
				const displayText = intent
					? `${formatIntent(intent)}${humanText ? ` — ${humanText}` : ""}`
					: m.text;
				lines.push(`[${m.timestamp}] **${m.from}**: ${displayText}`);
				if (intent) {
					intents.push({ timestamp: m.timestamp, intent });
				}
			}

			let output = `## #${args.channel}\n\n${lines.join("\n")}`;
			if (intents.length > 0) {
				output += `\n\n---\n**Intents detected:** ${intents.length}`;
				for (const { timestamp, intent } of intents) {
					output += `\n- ${timestamp}: ${intent.type} on ${intent.proposalId} by ${intent.from}`;
				}
			}

			return { content: [{ type: "text", text: output }] };
		} catch (error) {
			throw new McpError(
				`Failed to read messages: ${(error as Error).message}`,
				"OPERATION_FAILED",
			);
		}
	}

	async sendMessage(args: MessageSendArgs): Promise<CallToolResult> {
		try {
			let type: "public" | "group" | "private" = "group";
			let group: string | undefined;
			let to: string | undefined;

			if (args.to) {
				type = "private";
				to = args.to.replace(/^@/, "");
			} else if (args.channel === "public") {
				type = "public";
			} else {
				type = "group";
				group = args.channel ?? "project";
			}

			// Encode intent if provided
			let message = args.message;
			if (args.intent) {
				const intentPayload = encodeIntent({
					...args.intent,
					from: args.from,
					timestamp: new Date().toISOString(),
				});
				message = `${intentPayload}\n${args.message}`;
			}

			await this.core.sendMessage({
				from: args.from,
				message,
				type,
				group,
				to,
			});
			const dest = to ? `@${to}` : `#${group ?? "public"}`;
			const intentNote = args.intent
				? ` [intent: ${args.intent.type} on ${args.intent.proposalId}]`
				: "";
			return {
				content: [
					{ type: "text", text: `Message sent to ${dest}${intentNote}` },
				],
			};
		} catch (error) {
			throw new McpError(
				`Failed to send message: ${(error as Error).message}`,
				"OPERATION_FAILED",
			);
		}
	}
}
