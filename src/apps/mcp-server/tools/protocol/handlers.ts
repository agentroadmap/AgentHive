/**
 * MCP tool handlers for message protocol operations
 *
 * STATE-49: Inter-Agent Communication Protocol
 * AC#3: Agent mentions trigger notifications
 * AC#4: Message threading supported
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	appendMessage,
	buildThreads,
	ensureChannelFile,
	findMentionsForAgent,
	formatMentionNotification,
	formatThread,
	type MentionNotification,
	type MessagePriority,
	parseMessagesFromFile,
	type Thread,
} from "../../../../core/messaging/message-protocol.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export class ProtocolHandlers {
	private readonly messagesDir: string;

	constructor(private readonly server: McpServer) {
		this.messagesDir = join(process.cwd(), "roadmap", "messages");
	}

	/**
	 * AC#3: Search for mentions of an agent.
	 */
	async searchMentions(args: {
		agent: string;
		channel?: string;
		since?: string;
	}): Promise<CallToolResult> {
		try {
			const allMentions: MentionNotification[] = [];

			if (args.channel) {
				// Search specific channel
				const filePath = join(this.messagesDir, `group-${args.channel}.md`);
				const altPath = join(this.messagesDir, `private-${args.channel}.md`);
				const publicPath = join(this.messagesDir, "PUBLIC.md");

				const paths = [filePath, altPath, publicPath].filter((p) =>
					existsSync(p),
				);

				for (const path of paths) {
					const messages = parseMessagesFromFile(path, args.channel);
					const filtered = args.since
						? messages.filter((m) => m.timestamp >= args.since!)
						: messages;
					allMentions.push(...findMentionsForAgent(filtered, args.agent));
				}
			} else {
				// Search all channels
				if (existsSync(this.messagesDir)) {
					const files = readdirSync(this.messagesDir).filter((f) =>
						f.endsWith(".md"),
					);
					for (const file of files) {
						const channel = file
							.replace(/^(group|private)-/, "")
							.replace(/\.md$/, "");
						const filePath = join(this.messagesDir, file);
						const messages = parseMessagesFromFile(filePath, channel);
						const filtered = args.since
							? messages.filter((m) => m.timestamp >= args.since!)
							: messages;
						allMentions.push(...findMentionsForAgent(filtered, args.agent));
					}
				}
			}

			if (allMentions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No mentions found for @${args.agent}${args.channel ? ` in #${args.channel}` : ""}.`,
						},
					],
				};
			}

			const lines = [`## Mentions for @${args.agent} (${allMentions.length})`];
			for (const notification of allMentions) {
				lines.push("");
				lines.push(formatMentionNotification(notification));
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#4: Get a specific thread.
	 */
	async getThread(args: {
		messageId: string;
		channel: string;
	}): Promise<CallToolResult> {
		try {
			const filePath = join(this.messagesDir, `group-${args.channel}.md`);
			if (!existsSync(filePath)) {
				return {
					content: [
						{ type: "text", text: `Channel #${args.channel} not found.` },
					],
				};
			}

			const messages = parseMessagesFromFile(filePath, args.channel);
			const threads = buildThreads(messages);

			const thread = threads.find((t) => t.id === args.messageId);
			if (!thread) {
				// Check if the message exists but has no replies
				const parentMsg = messages.find(
					(m) => m.id === args.messageId || m.raw.includes(args.messageId),
				);
				if (!parentMsg) {
					return {
						content: [
							{
								type: "text",
								text: `Message ${args.messageId} not found in #${args.channel}.`,
							},
						],
					};
				}

				// Create a single-message thread
				const singleThread: Thread = {
					id: args.messageId,
					parent: parentMsg,
					replies: [],
					lastActivity: parentMsg.timestamp,
					participants: [parentMsg.from],
				};

				return {
					content: [{ type: "text", text: formatThread(singleThread) }],
				};
			}

			return {
				content: [{ type: "text", text: formatThread(thread) }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#4: List threads in a channel.
	 */
	async listThreads(args: {
		channel: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const filePath = join(this.messagesDir, `group-${args.channel}.md`);
			if (!existsSync(filePath)) {
				return {
					content: [
						{ type: "text", text: `Channel #${args.channel} not found.` },
					],
				};
			}

			const messages = parseMessagesFromFile(filePath, args.channel);
			const threads = buildThreads(messages);

			const limitedThreads = args.limit
				? threads.slice(0, args.limit)
				: threads;

			if (limitedThreads.length === 0) {
				return {
					content: [
						{ type: "text", text: `No threads found in #${args.channel}.` },
					],
				};
			}

			const lines = [
				`## Threads in #${args.channel} (${threads.length} total)`,
			];
			for (const thread of limitedThreads) {
				lines.push("");
				lines.push(`### ${thread.id}`);
				lines.push(
					`- **${thread.parent.from}**: ${thread.parent.content.substring(0, 80)}...`,
				);
				lines.push(`- Replies: ${thread.replies.length}`);
				lines.push(`- Participants: ${thread.participants.join(", ")}`);
				lines.push(`- Last activity: ${thread.lastActivity}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#4: Reply to a thread.
	 */
	async replyToThread(args: {
		from: string;
		channel: string;
		threadId: string;
		content: string;
		priority?: MessagePriority;
	}): Promise<CallToolResult> {
		try {
			ensureChannelFile(this.messagesDir, args.channel);

			const line = appendMessage(this.messagesDir, args.channel, {
				from: args.from,
				content: args.content,
				priority: args.priority || "normal",
				threadId: args.threadId,
			});

			return {
				content: [
					{
						type: "text",
						text: `Reply sent to thread ${args.threadId} in #${args.channel}:\n${line}`,
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#3: Send a message with mentions.
	 */
	async sendWithMentions(args: {
		from: string;
		channel: string;
		content: string;
		mentions?: string[];
		priority?: MessagePriority;
		replyTo?: string;
	}): Promise<CallToolResult> {
		try {
			ensureChannelFile(this.messagesDir, args.channel);

			// Add @ prefix to mentions if not present
			let content = args.content;
			if (args.mentions && args.mentions.length > 0) {
				for (const mention of args.mentions) {
					if (!content.includes(`@${mention}`)) {
						content = `@${mention} ${content}`;
					}
				}
			}

			const line = appendMessage(this.messagesDir, args.channel, {
				from: args.from,
				content,
				priority: args.priority || "normal",
				replyTo: args.replyTo,
			});

			// Extract mentions for notification info
			const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
			const mentioned: string[] = [];
			let match: RegExpExecArray | null = mentionRegex.exec(content);
			while (match !== null) {
				const mention = match[1];
				if (!mentioned.includes(mention)) {
					mentioned.push(mention);
				}
				match = mentionRegex.exec(content);
			}

			let response = `Message sent to #${args.channel}:\n${line}`;
			if (mentioned.length > 0) {
				response += `\n\nMentioned agents: ${mentioned.join(", ")}`;
				response += `\n(They will see this mention when checking notifications)`;
			}

			return {
				content: [{ type: "text", text: response }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	/**
	 * AC#3: Get all notifications for an agent.
	 */
	async getNotifications(args: {
		agent: string;
		channel?: string;
		since?: string;
	}): Promise<CallToolResult> {
		try {
			const allMentions: MentionNotification[] = [];

			if (existsSync(this.messagesDir)) {
				const files = readdirSync(this.messagesDir).filter((f) =>
					f.endsWith(".md"),
				);

				for (const file of files) {
					const channel = file
						.replace(/^(group|private)-/, "")
						.replace(/\.md$/, "");

					// Skip if specific channel requested and this isn't it
					if (args.channel && channel !== args.channel) continue;

					const filePath = join(this.messagesDir, file);
					const messages = parseMessagesFromFile(filePath, channel);

					// Filter by since timestamp
					const filtered = args.since
						? messages.filter((m) => m.timestamp >= args.since!)
						: messages;

					allMentions.push(...findMentionsForAgent(filtered, args.agent));
				}
			}

			if (allMentions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No notifications for @${args.agent}${args.since ? ` since ${args.since}` : ""}.`,
						},
					],
				};
			}

			// Group by priority
			const urgent = allMentions.filter((n) => n.message.priority === "urgent");
			const high = allMentions.filter((n) => n.message.priority === "high");
			const normal = allMentions.filter(
				(n) => n.message.priority === "normal" || n.message.priority === "low",
			);

			const lines = [`## Notifications for @${args.agent}`];
			lines.push(`Total: ${allMentions.length} mentions\n`);

			if (urgent.length > 0) {
				lines.push(`### 🔴 Urgent (${urgent.length})`);
				for (const n of urgent) {
					lines.push(
						`- [${n.message.timestamp}] **${n.message.from}** in #${n.channel}: ${n.message.content}`,
					);
				}
				lines.push("");
			}

			if (high.length > 0) {
				lines.push(`### 🟡 High Priority (${high.length})`);
				for (const n of high) {
					lines.push(
						`- [${n.message.timestamp}] **${n.message.from}** in #${n.channel}: ${n.message.content}`,
					);
				}
				lines.push("");
			}

			if (normal.length > 0) {
				lines.push(`### 🟢 Normal (${normal.length})`);
				for (const n of normal) {
					lines.push(
						`- [${n.message.timestamp}] **${n.message.from}** in #${n.channel}: ${n.message.content}`,
					);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}
}
