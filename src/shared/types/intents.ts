/**
 * Structured negotiation intents for agent coordination.
 * Ties chat messages to concrete proposal operations.
 */

export type IntentType =
	| "claim_request"
	| "handoff"
	| "reject"
	| "accept"
	| "block";

export interface NegotiationIntent {
	/** Intent type */
	type: IntentType;
	/** Target proposal ID */
	proposalId: string;
	/** Agent sending the intent */
	from: string;
	/** Target agent (for claim_request, handoff) */
	to?: string;
	/** Human-readable reason */
	reason?: string;
	/** Timestamp when intent was created */
	timestamp?: string;
}

/**
 * Prefix used to encode intents in message text.
 * Format: __intent__:{"type":"claim_request","proposalId":"STATE-9",...}
 */
export const INTENT_PREFIX = "__intent__:";

/**
 * Encode a negotiation intent to a string that can be embedded in a message.
 * The message should also include human-readable text after the intent payload.
 */
export function encodeIntent(intent: NegotiationIntent): string {
	const payload = {
		type: intent.type,
		proposalId: intent.proposalId,
		from: intent.from,
		...(intent.to && { to: intent.to }),
		...(intent.reason && { reason: intent.reason }),
		...(intent.timestamp && { timestamp: intent.timestamp }),
	};
	return `${INTENT_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * Decode a negotiation intent from message text.
 * Returns null if the message doesn't contain an intent.
 */
export function decodeIntent(text: string): NegotiationIntent | null {
	if (!text.includes(INTENT_PREFIX)) return null;

	const match = text.match(
		new RegExp(
			`${INTENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+?)(?:\\n|$)`,
		),
	);
	if (!match || !match[1]) return null;

	try {
		const payload = JSON.parse(match[1]);
		return {
			type: payload.type as IntentType,
			proposalId: payload.proposalId,
			from: payload.from,
			to: payload.to,
			reason: payload.reason,
			timestamp: payload.timestamp,
		};
	} catch {
		return null;
	}
}

/**
 * Extract human-readable text from a message that contains an intent.
 */
export function extractHumanText(text: string): string {
	if (!text.includes(INTENT_PREFIX)) return text;
	return text
		.replace(
			new RegExp(
				`${INTENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+?(?:\\n|$)`,
			),
			"",
		)
		.trim();
}

/**
 * Format an intent as human-readable text for display.
 */
export function formatIntent(intent: NegotiationIntent): string {
	switch (intent.type) {
		case "claim_request":
			return `[Claim Request] ${intent.from} requests to claim ${intent.proposalId}${intent.to ? ` (to @${intent.to})` : ""}${intent.reason ? `: ${intent.reason}` : ""}`;
		case "handoff":
			return `[Handoff] ${intent.from} hands off ${intent.proposalId} to @${intent.to}${intent.reason ? `: ${intent.reason}` : ""}`;
		case "reject":
			return `[Reject] ${intent.from} rejects ${intent.proposalId}${intent.reason ? `: ${intent.reason}` : ""}`;
		case "accept":
			return `[Accept] ${intent.from} accepts ${intent.proposalId}${intent.reason ? `: ${intent.reason}` : ""}`;
		case "block":
			return `[Block] ${intent.from} blocks ${intent.proposalId}${intent.reason ? `: ${intent.reason}` : ""}`;
		default:
			return `[${intent.type}] ${intent.from} -> ${intent.proposalId}`;
	}
}
