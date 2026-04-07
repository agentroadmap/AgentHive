/**
 * STATE-49: Inter-Agent Communication Protocol
 *
 * Standard protocol for agents to communicate asynchronously via the roadmap
 * messaging system. Enables collaboration without real-time dependencies.
 *
 * AC#1: Agents can send messages to channels ✅ (existing msg_send tool)
 * AC#2: Messages persisted in markdown files ✅ (existing markdown storage)
 * AC#3: Agent mentions trigger notifications (this file)
 * AC#4: Message threading supported (this file)
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Message priority levels */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/** Message types */
export type MessageType =
	| "text"
	| "mention"
	| "thread_reply"
	| "intent"
	| "system";

/** Parsed message with metadata */
export interface ParsedMessage {
	/** Unique message identifier */
	id: string;
	/** Timestamp in ISO format */
	timestamp: string;
	/** Sender name */
	from: string;
	/** Message content */
	content: string;
	/** Message type */
	type: MessageType;
	/** Priority level */
	priority: MessagePriority;
	/** Mentioned agent names */
	mentions: string[];
	/** Thread ID (if this is a thread reply) */
	threadId?: string;
	/** Parent message ID (if this is a reply) */
	replyTo?: string;
	/** Channel name */
	channel: string;
	/** Raw line from the file */
	raw: string;
}

/** Thread summary */
export interface Thread {
	/** Thread ID (parent message ID) */
	id: string;
	/** Parent message */
	parent: ParsedMessage;
	/** Reply messages */
	replies: ParsedMessage[];
	/** Last activity timestamp */
	lastActivity: string;
	/** Participants (unique sender names) */
	participants: string[];
}

/** Notification for a mention */
export interface MentionNotification {
	/** Mentioned agent name */
	agent: string;
	/** Message that mentioned them */
	message: ParsedMessage;
	/** Channel where the mention occurred */
	channel: string;
}

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 6);
	return `MSG-${timestamp}-${random}`;
}

/**
 * Extract mentions from message content.
 * Mentions are in the format @agent-name or @agent_name
 */
export function extractMentions(content: string): string[] {
	const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
	const mentions: string[] = [];
	let match: RegExpExecArray | null = mentionRegex.exec(content);

	while (match !== null) {
		const name = match[1].toLowerCase();
		if (!mentions.includes(name)) {
			mentions.push(name);
		}
		match = mentionRegex.exec(content);
	}

	return mentions;
}

/**
 * Parse a raw message line from a markdown file.
 * Format: [timestamp] sender: content
 * With optional metadata: [timestamp] sender [priority=high] [thread=MSG-xxx]: content
 */
export function parseMessageLine(
	line: string,
	channel: string,
): ParsedMessage | null {
	// Match format: [timestamp] sender [metadata...]: content
	const basicMatch = line.match(/^\[([^\]]+)\]\s+([^:]+?):\s*(.*)$/);
	if (!basicMatch) return null;

	const timestamp = basicMatch[1];
	const senderAndMeta = basicMatch[2];
	const rawContent = basicMatch[3];

	let priority: MessagePriority = "normal";
	let threadId: string | undefined;
	let replyTo: string | undefined;

	// Parse metadata blocks: [key=value] can appear between sender and colon
	let sender = senderAndMeta;
	let cleanContent = rawContent;

	const metaRegex = /\[(\w+)=([^\]]+)\]/g;
	let metaMatch: RegExpExecArray | null = metaRegex.exec(senderAndMeta);
	while (metaMatch !== null) {
		const key = metaMatch[1].toLowerCase();
		const value = metaMatch[2];
		if (key === "priority") {
			priority = value.toLowerCase() as MessagePriority;
			// Remove this metadata from sender
			sender = sender.replace(metaMatch[0], "").trim();
		} else if (key === "thread") {
			threadId = value;
			replyTo = value;
			sender = sender.replace(metaMatch[0], "").trim();
		} else if (key === "reply") {
			replyTo = value;
			sender = sender.replace(metaMatch[0], "").trim();
		}
		metaMatch = metaRegex.exec(senderAndMeta);
	}

	// Also check inline metadata in content (fallback)
	const priorityMatch = cleanContent.match(/\[priority=(\w+)\]\s*/);
	if (priorityMatch && priority === "normal") {
		priority = priorityMatch[1]?.toLowerCase() as MessagePriority;
		cleanContent = cleanContent.replace(priorityMatch[0], "");
	}

	const threadMatch = cleanContent.match(/\[thread=([A-Z0-9-]+)\]\s*/);
	if (threadMatch && !threadId) {
		threadId = threadMatch[1];
		replyTo = threadMatch[1];
		cleanContent = cleanContent.replace(threadMatch[0], "");
	}

	const replyMatch = cleanContent.match(/\[reply=([A-Z0-9-]+)\]\s*/);
	if (replyMatch && !replyTo) {
		replyTo = replyMatch[1];
		cleanContent = cleanContent.replace(replyMatch[0], "");
	}

	// Determine message type
	const mentions = extractMentions(cleanContent);
	let type: MessageType = "text";
	if (mentions.length > 0) {
		type = "mention";
	} else if (threadId || replyTo) {
		type = "thread_reply";
	}

	return {
		id: generateMessageId(),
		timestamp,
		from: sender.trim().toLowerCase(),
		content: cleanContent.trim(),
		type,
		priority,
		mentions,
		threadId,
		replyTo,
		channel,
		raw: line,
	};
}

/**
 * Parse all messages from a markdown file.
 */
export function parseMessagesFromFile(
	filePath: string,
	channel: string,
): ParsedMessage[] {
	if (!existsSync(filePath)) return [];

	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	const messages: ParsedMessage[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const message = parseMessageLine(trimmed, channel);
		if (message) {
			messages.push(message);
		}
	}

	return messages;
}

/**
 * Format a message for writing to a markdown file.
 */
export function formatMessage(options: {
	from: string;
	content: string;
	priority?: MessagePriority;
	threadId?: string;
	replyTo?: string;
}): string {
	const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
	let line = `[${timestamp}] ${options.from}:`;

	if (options.priority && options.priority !== "normal") {
		line += ` [priority=${options.priority}]`;
	}

	if (options.threadId) {
		line += ` [thread=${options.threadId}]`;
	} else if (options.replyTo) {
		line += ` [reply=${options.replyTo}]`;
	}

	line += ` ${options.content}`;
	return line;
}

/**
 * AC#4: Build thread view from messages.
 */
export function buildThreads(messages: ParsedMessage[]): Thread[] {
	const threadMap = new Map<string, ParsedMessage[]>();
	const parentMessages = new Map<string, ParsedMessage>();

	// Identify threads
	for (const message of messages) {
		if (message.threadId) {
			// This is a reply in a thread
			const replies = threadMap.get(message.threadId) || [];
			replies.push(message);
			threadMap.set(message.threadId, replies);
		} else {
			// This might be a parent message
			parentMessages.set(message.id, message);
		}
	}

	// Build thread objects
	const threads: Thread[] = [];

	for (const [threadId, replies] of threadMap) {
		const parent = parentMessages.get(threadId);
		if (!parent) continue;

		// Sort replies by timestamp
		replies.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

		// Get unique participants
		const participants = new Set<string>();
		participants.add(parent.from);
		for (const reply of replies) {
			participants.add(reply.from);
		}

		threads.push({
			id: threadId,
			parent,
			replies,
			lastActivity: replies[replies.length - 1]?.timestamp || parent.timestamp,
			participants: Array.from(participants),
		});
	}

	// Sort by last activity
	threads.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

	return threads;
}

/**
 * AC#3: Find all mentions for a specific agent.
 */
export function findMentionsForAgent(
	messages: ParsedMessage[],
	agentName: string,
): MentionNotification[] {
	const notifications: MentionNotification[] = [];
	const normalizedAgent = agentName.toLowerCase().replace(/^@/, "");

	for (const message of messages) {
		if (message.mentions.includes(normalizedAgent)) {
			// Don't notify yourself
			if (message.from === normalizedAgent) continue;

			notifications.push({
				agent: normalizedAgent,
				message,
				channel: message.channel,
			});
		}
	}

	return notifications;
}

/**
 * AC#3: Format a notification for a mention.
 */
export function formatMentionNotification(
	notification: MentionNotification,
): string {
	const lines = [
		`Mention in #${notification.channel}`,
		`From: ${notification.message.from}`,
		`Time: ${notification.message.timestamp}`,
		`Message: ${notification.message.content}`,
	];

	if (notification.message.replyTo) {
		lines.push(`Reply to: ${notification.message.replyTo}`);
	}

	return lines.join("\n");
}

/**
 * AC#4: Format a thread for display.
 */
export function formatThread(thread: Thread): string {
	const header = `## Thread: ${thread.id}`;
	const parentLine = `**${thread.parent.from}** (${thread.parent.timestamp}):`;
	const lines: string[] = [header, "", parentLine, thread.parent.content, ""];

	if (thread.replies.length > 0) {
		const divider = `--- ${thread.replies.length} replies ---`;
		lines.push(divider);
		lines.push("");
		for (const reply of thread.replies) {
			const replyLine = `**${reply.from}** (${reply.timestamp}):`;
			lines.push(replyLine);
			lines.push(reply.content);
			lines.push("");
		}
	}

	const participants = `Participants: ${thread.participants.join(", ")}`;
	lines.push(participants);
	return lines.join("\n");
}

/**
 * Write a new message to a channel file.
 */
export function appendMessage(
	messagesDir: string,
	channel: string,
	options: {
		from: string;
		content: string;
		priority?: MessagePriority;
		threadId?: string;
		replyTo?: string;
	},
): string {
	const channelFile = getChannelFilePath(messagesDir, channel);
	const formattedLine = formatMessage(options);

	appendFileSync(channelFile, `${formattedLine}\n`);

	return formattedLine;
}

/**
 * Get the file path for a channel.
 */
export function getChannelFilePath(
	messagesDir: string,
	channel: string,
): string {
	// Normalize channel name
	const normalizedName = channel.toLowerCase().replace(/\s+/g, "-");

	// Determine file prefix based on channel type
	let prefix = "group";
	if (normalizedName === "public") {
		return join(messagesDir, "PUBLIC.md");
	} else if (normalizedName.includes("-")) {
		// Private DM channels have format: agent1-agent2
		const parts = normalizedName.split("-");
		if (parts.length === 2) {
			prefix = "private";
			// Sort for consistent naming
			parts.sort();
			return join(messagesDir, `${prefix}-${parts[0]}-${parts[1]}.md`);
		}
	}

	return join(messagesDir, `${prefix}-${normalizedName}.md`);
}

/**
 * Initialize a channel file with header if it doesn't exist.
 */
export function ensureChannelFile(messagesDir: string, channel: string): void {
	if (!existsSync(messagesDir)) {
		mkdirSync(messagesDir, { recursive: true });
	}

	const filePath = getChannelFilePath(messagesDir, channel);

	if (!existsSync(filePath)) {
		const channelType =
			channel === "public"
				? "Public"
				: channel.includes("-")
					? "Private DM"
					: "Group Chat";
		const header = `# ${channelType}: #${channel}\n\n`;
		writeFileSync(filePath, header);
	}
}

/**
 * Get all mentioned agents from a batch of messages.
 */
export function getAllMentions(
	messages: ParsedMessage[],
): Map<string, ParsedMessage[]> {
	const mentionsByAgent = new Map<string, ParsedMessage[]>();

	for (const message of messages) {
		for (const mentioned of message.mentions) {
			const existing = mentionsByAgent.get(mentioned) || [];
			existing.push(message);
			mentionsByAgent.set(mentioned, existing);
		}
	}

	return mentionsByAgent;
}

/**
 * Check if a message should trigger a notification for an agent.
 */
export function shouldNotify(
	message: ParsedMessage,
	agentName: string,
): boolean {
	const normalizedAgent = agentName.toLowerCase().replace(/^@/, "");

	// Check for direct mention
	if (message.mentions.includes(normalizedAgent)) {
		// Don't notify yourself
		return message.from !== normalizedAgent;
	}

	// Could add more notification rules here:
	// - Direct messages always notify
	// - @channel mentions
	// - Priority messages

	return false;
}
