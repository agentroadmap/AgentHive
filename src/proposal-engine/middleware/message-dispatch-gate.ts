/**
 * P209: Message Dispatch Gate
 *
 * Enforces trust tier constraints on message sends before insertion into message_ledger.
 * Blocks denied messages silently (no error to sender) and logs for audit.
 *
 * Detects repeated denial patterns (>3 in 5 min from same sender) and triggers escalation.
 */

import { query } from "../../postgres/pool.ts";
import { resolveTrust, type TrustContext } from "../../infra/trust/trust-resolver.ts";

export interface DispatchGateRequest {
	/** Sending agent identity */
	from_agent: string;
	/** Receiving agent (if private message) */
	to_agent?: string;
	/** Channel or broadcast context */
	channel?: string;
	/** Message type for policy check */
	message_type?: string;
	/** Proposal being discussed */
	proposal_id?: string;
}

export interface DispatchGateResult {
	/** Whether the message is allowed */
	allowed: boolean;
	/** Human-readable reason for decision */
	reason: string;
	/** Whether escalation is required (repeated blocks) */
	escalationRequired: boolean;
	/** Escalation reason if applicable */
	escalationReason?: string;
}

/**
 * Check if an agent has sent >3 denied messages in the last 5 minutes.
 * Triggers REPEATED_MESSAGE_DENIAL escalation.
 */
async function checkRepeatedDenials(agentId: string): Promise<{
	count: number;
	escalate: boolean;
}> {
	const result = await query<{ count: number }>(
		`SELECT COUNT(*) as count FROM roadmap_messaging.denied_messages
		 WHERE from_agent = $1 AND timestamp > now() - interval '5 minutes'`,
		[agentId],
	);

	const count = result.rows[0]?.count ?? 0;
	return {
		count,
		escalate: count >= 3,
	};
}

/**
 * Log a denied message attempt to the denied_messages table.
 */
async function logDeniedMessage(
	req: DispatchGateRequest,
	reason: string,
	tier: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap_messaging.denied_messages
		 (from_agent, to_agent, message_type, reason, trust_tier, timestamp)
		 VALUES ($1, $2, $3, $4, $5, now())`,
		[req.from_agent, req.to_agent || null, req.message_type || "text", reason, tier],
	);
}

/**
 * Create an escalation record for repeated denials or transition violations.
 */
async function createEscalation(
	type: "REPEATED_MESSAGE_DENIAL" | "UNAUTHORIZED_GATE_TRANSITION",
	agentId: string,
	details: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap_control.escalation (type, agent_identity, details, created_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT DO NOTHING`,
		[type, agentId, details],
	);
}

/**
 * Enforce message dispatch gate: check trust tier and policy before send.
 *
 * Returns {allowed: false} if blocked, with reason logged to denied_messages.
 * Silent failure (no exception thrown).
 *
 * AC-1: Blocks unauthorized message types per trust tier.
 * AC-3: Logs denied messages with reason and timestamp.
 * AC-5: Escalates repeated patterns (>3 denials in 5 min).
 */
export async function enforceMessageGate(
	req: DispatchGateRequest,
): Promise<DispatchGateResult> {
	// Determine receiver for trust context
	const receiver = req.to_agent || "broadcast";

	// Resolve trust between sender and receiver
	const trustContext: TrustContext = {
		sender: req.from_agent,
		receiver,
		messageType: req.message_type,
		channel: req.channel,
	};

	const trustResult = await resolveTrust(trustContext);

	// If trust allows the message, permit it
	if (trustResult.allowed) {
		return {
			allowed: true,
			reason: `Trust tier ${trustResult.tier}: ${trustResult.reason}`,
			escalationRequired: false,
		};
	}

	// Trust check failed: log denial and check for repeated patterns
	const denialReason = `Trust tier ${trustResult.tier} denies message type ${req.message_type || "text"}`;
	await logDeniedMessage(req, denialReason, trustResult.tier);

	// Check for repeated denial pattern
	const { count, escalate } = await checkRepeatedDenials(req.from_agent);

	if (escalate) {
		await createEscalation(
			"REPEATED_MESSAGE_DENIAL",
			req.from_agent,
			`Agent ${req.from_agent} has ${count} denied messages in 5 minutes. Trust tier: ${trustResult.tier}`,
		);
	}

	return {
		allowed: false,
		reason: denialReason,
		escalationRequired: escalate,
		escalationReason: escalate
			? `Repeated message denials from ${req.from_agent} (${count} in 5 min)`
			: undefined,
	};
}
