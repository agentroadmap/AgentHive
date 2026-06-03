/**
 * P159: Agent Identity Verification Middleware
 *
 * Implements soft-fail mode (log-only) by default.
 * Hard-fail mode requires AGENTHIVE_AUTH_REQUIRED=true environment variable.
 *
 * Verification happens at MCP tool handler boundaries:
 * - msg_send validates from_agent signature if public_key exists in registry
 * - agent_register validates caller identity against registered keys
 * - propose_change validates proposal editor against stored public key
 *
 * Soft-fail behavior: unsigned/unverified requests are LOGGED but not REJECTED,
 * maintaining backward compatibility with agents that lack keys yet.
 */

import { getAgentPublicKey } from "./agent-registry/registry.ts";
import { verifySignature } from "./agent-identity.ts";

export interface VerificationContext {
	agentId: string;
	signature?: string; // hex-encoded Ed25519 signature
	data?: string; // signed data (JSON payload or message content)}
	softFailMode: boolean;
	rejected: boolean;
	reason?: string;
}

/**
 * P159 AC-5: Verify agent identity using public key from agent_registry.
 *
 * Soft-fail mode (default):
 *   - Missing key: LOG_ONLY, allow request
 *   - Invalid signature: LOG_ONLY, allow request
 *   - Valid signature: allow request
 *
 * Hard-fail mode (AGENTHIVE_AUTH_REQUIRED=true):
 *   - Missing key: REJECT with 401
 *   - Invalid signature: REJECT with 403
 *   - Valid signature: ALLOW
 *
 * Returns VerificationContext for caller to decide action.
 */
export async function verifyAgentIdentity(
	agentId: string,
	signature?: string,
	data?: string,
): Promise<VerificationContext> {
	const softFailMode = process.env.AGENTHIVE_AUTH_REQUIRED !== "true";
	const context: VerificationContext = {
		agentId,
		signature,
		data,
		softFailMode,
		rejected: false,
	};

	// Soft-fail: no signature provided — just log and allow
	if (!signature || !data) {
		const reason = "unsigned_request";
		console.log(
			`[P159-SOFT] ${agentId} - unsigned request (no signature/data). Mode: soft-fail.`,
		);
		if (!softFailMode) {
			context.rejected = true;
			context.reason = reason;
		}
		return context;
	}

	// Retrieve public key from agent_registry
	let publicKey: string | null;
	try {
		publicKey = await getAgentPublicKey(agentId);
	} catch (err) {
		// DB unavailable — always soft-fail
		console.warn(
			`[P159-SOFT] ${agentId} - failed to lookup public_key in agent_registry:`,
			err instanceof Error ? err.message : String(err),
		);
		return context;
	}

	// Agent has no public key registered
	if (!publicKey) {
		const reason = "public_key_not_found";
		console.log(
			`[P159-SOFT] ${agentId} - no public_key in agent_registry. Mode: soft-fail.`,
		);
		if (!softFailMode) {
			context.rejected = true;
			context.reason = reason;
		}
		return context;
	}

	// Verify signature against public key
	const isValid = verifySignature(publicKey, data, signature);
	if (!isValid) {
		const reason = "signature_verification_failed";
		console.log(
			`[P159-SOFT] ${agentId} - signature verification failed. Mode: soft-fail.`,
		);
		if (!softFailMode) {
			context.rejected = true;
			context.reason = reason;
		}
		return context;
	}

	// Signature valid
	console.log(
		`[P159] ${agentId} - signature verified successfully. Granting access.`,
	);
	return context;
}

/**
 * Emit audit event for verification outcome (soft-fail only, no rejection action).
 * Used to track which agents are using signed requests vs. legacy unsigned.
 */
export async function logVerificationEvent(
	agentId: string,
	eventType: "signed" | "unsigned" | "failed_signature",
): Promise<void> {
	try {
		// Best-effort: audit events must never block request handling
		console.log(`[P159-AUDIT] ${agentId} - ${eventType}`);
		// TODO: write to operator_audit_log table
	} catch {
		// Ignore audit failures
	}
}
