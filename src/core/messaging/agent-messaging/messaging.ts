/**
 * S147.2: 1:1 Agent-to-Agent Messaging
 *
 * Postgres-backed agent messaging via the `message_ledger` table.
 * Replaces the former in-memory array so agents in separate worktrees
 * can exchange messages that survive process restarts.
 *
 * DB table: message_ledger
 *   id              — bigint PK
 *   from_agent      — sender identity
 *   to_agent        — recipient identity (null = broadcast to channel)
 *   channel         — channel name (null = direct message)
 *   message_content — message text
 *   message_type    — 'text' | 'task' | 'status' | 'system' | 'reply:<replyTo>'
 *   proposal_id     — optional proposal context
 *   created_at      — timestamp
 */

import { query } from "../../../infra/postgres/pool.ts";
import { getAgent } from "../../identity/agent-registry/index.ts";
import type {
	AgentMessage,
	MessageFilter,
	MessageType,
	SendMessageRequest,
	SendMessageResponse,
} from "./types.ts";

/** Encode replyTo into message_type field since message_ledger has no reply_to column. */
function encodeType(type: MessageType, replyTo?: string): string {
	if (replyTo) return `reply:${replyTo}:${type}`;
	return type;
}

/** Decode message_type field back to type + replyTo. */
function decodeType(raw: string): { type: MessageType; replyTo?: string } {
	if (raw.startsWith("reply:")) {
		const parts = raw.split(":");
		// format: reply:<replyTo>:<type>
		const replyTo = parts[1];
		const type = (parts[2] ?? "task") as MessageType;
		return { type, replyTo };
	}
	return { type: raw as MessageType };
}

/** Map a message_ledger DB row to AgentMessage. */
function hydrateMessage(row: any): AgentMessage {
	const { type, replyTo } = decodeType(row.message_type ?? "task");
	return {
		id: String(row.id),
		from: row.from_agent,
		to: row.to_agent ?? "",
		type,
		content: row.message_content,
		timestamp:
			row.created_at instanceof Date
				? row.created_at.toISOString()
				: String(row.created_at),
		replyTo,
		metadata: row.proposal_id ? { proposalId: row.proposal_id } : undefined,
	};
}

/**
 * Send direct message from one agent to another.
 * Routes via Postgres message_ledger for cross-process durability.
 */
export async function sendMessage(
	request: SendMessageRequest,
): Promise<SendMessageResponse> {
	const { from, to, type, content, replyTo, metadata } = request;

	// Resolve channel from agent registry (best-effort, fall back to convention)
	const targetAgent = await getAgent(to).catch(() => undefined);
	const channel = targetAgent?.channel ?? `agent-${to.toLowerCase()}`;

	const encodedType = encodeType(type, replyTo);
	const proposalId = metadata?.proposalId ?? null;

	const { rows } = await query(
		`INSERT INTO message_ledger (from_agent, to_agent, channel, message_content, message_type, proposal_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
		[from, to, channel, content, encodedType, proposalId],
	);

	const id = String(rows[0].id);

	return {
		success: true,
		messageId: id,
		channel,
	};
}

/**
 * Get messages for an agent (their inbox + outbox).
 */
export async function getMessages(
	filter: MessageFilter,
): Promise<AgentMessage[]> {
	const { agentId, since, type, limit = 50 } = filter;

	const params: unknown[] = [agentId, agentId];
	let whereClauses = `(to_agent = $1 OR from_agent = $2)`;
	let idx = 3;

	if (since) {
		whereClauses += ` AND created_at > $${idx++}`;
		params.push(since);
	}

	if (type) {
		// message_type may have encoded prefix; check with LIKE
		whereClauses += ` AND (message_type = $${idx} OR message_type LIKE $${idx + 1})`;
		params.push(type, `reply:%:${type}`);
		idx += 2;
	}

	params.push(limit);
	const { rows } = await query(
		`SELECT id, from_agent, to_agent, channel, message_content, message_type, proposal_id, created_at
     FROM message_ledger
     WHERE ${whereClauses}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
		params,
	);

	return rows.map(hydrateMessage).reverse(); // return chronological order
}

/**
 * Get a single message by ID.
 */
export async function getMessage(
	messageId: string,
): Promise<AgentMessage | undefined> {
	const { rows } = await query(
		`SELECT id, from_agent, to_agent, channel, message_content, message_type, proposal_id, created_at
     FROM message_ledger WHERE id = $1`,
		[messageId],
	);
	return rows.length > 0 ? hydrateMessage(rows[0]) : undefined;
}

/**
 * Build reply chain — all messages in a thread via replyTo links.
 */
export async function getReplyChain(
	messageId: string,
): Promise<AgentMessage[]> {
	const chain: AgentMessage[] = [];
	let currentId: string | undefined = messageId;

	while (currentId) {
		const msg = await getMessage(currentId);
		if (!msg) break;
		chain.unshift(msg);
		currentId = msg.replyTo;
	}

	return chain;
}

/**
 * Acknowledge a message (no-op for now — message_ledger has no read state).
 * Returns true if the message exists.
 */
export async function acknowledgeMessage(messageId: string): Promise<boolean> {
	const msg = await getMessage(messageId);
	return msg !== undefined;
}

/**
 * Clear messages for testing — deletes all rows from message_ledger.
 * Only call in test environments.
 */
export async function clearMessages(): Promise<void> {
	await query(`DELETE FROM message_ledger`);
}
