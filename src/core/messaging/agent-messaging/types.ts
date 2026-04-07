/**
 * S147.2: 1:1 Agent-to-Agent Messaging Protocol
 *
 * Message format and types for direct agent communication.
 */

export type MessageType =
	| "task"
	| "query"
	| "response"
	| "status"
	| "ping"
	| "pong";

export interface AgentMessage {
	id: string;
	from: string;
	to: string;
	type: MessageType;
	content: string;
	timestamp: string;
	replyTo?: string;
	metadata?: Record<string, unknown>;
}

export interface SendMessageRequest {
	from: string;
	to: string;
	type: MessageType;
	content: string;
	replyTo?: string;
	metadata?: Record<string, unknown>;
}

export interface SendMessageResponse {
	success: boolean;
	messageId: string;
	channel: string;
}

export interface MessageFilter {
	agentId: string;
	since?: string;
	type?: MessageType;
	limit?: number;
}
