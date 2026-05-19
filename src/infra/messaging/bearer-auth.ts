/**
 * P1105 USER auth wiring — Bearer token verification for user/* agents
 *
 * Middleware to verify Authorization header carries a valid bearer token
 * for user-initiated messages. Non-user agents bypass verification.
 *
 * AC-27: msg_send, msg_reply, msg_wait_reply reject from_agent='user/*'
 * without valid Authorization header matching the sub claim.
 */

import { verifyBoundBearer } from "../../core/identity/principal-identity.js";
import type { BoundBearerPayload } from "../../core/identity/principal-identity.js";

export interface BearerAuthResult {
	valid: boolean;
	status?: number; // 401 or 403
	reason?: string; // 'missing_token' | 'invalid_sig' | 'token_expired' | 'sub_mismatch'
}

/**
 * Verify bearer token for user/* agents.
 *
 * @param authHeader - Raw Authorization header (e.g., "Bearer token...")
 * @param expectedFromAgent - The from_agent from the message (e.g., "user/gary")
 * @param operatorHmacSecret - The HMAC secret for verifying bearer token signature
 * @returns BearerAuthResult with valid=true if token verified, or status 401/403 on failure
 *
 * AC-27 logic:
 * - If expectedFromAgent doesn't start with 'user/' → return { valid: true } (non-user)
 * - If missing Authorization → return { valid: false, status: 401, reason: 'missing_token' }
 * - If token sig invalid → return { valid: false, status: 401, reason: 'invalid_sig' }
 * - If token expired → return { valid: false, status: 401, reason: 'token_expired' }
 * - If sub claim != expectedFromAgent → return { valid: false, status: 403, reason: 'sub_mismatch' }
 * - Otherwise → return { valid: true }
 */
export function verifyUserBearer(
	authHeader: string | undefined,
	expectedFromAgent: string,
	operatorHmacSecret: Buffer,
): BearerAuthResult {
	// Non-user agents bypass bearer verification
	if (!expectedFromAgent.startsWith("user/")) {
		return { valid: true };
	}

	// User agent requires Authorization header
	if (!authHeader) {
		return {
			valid: false,
			status: 401,
			reason: "missing_token",
		};
	}

	// Extract bearer token from "Bearer <token>" format
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match || !match[1]) {
		return {
			valid: false,
			status: 401,
			reason: "invalid_sig",
		};
	}

	const token = match[1];

	// Delegate to P472 bearer verifier
	try {
		const result = verifyBoundBearer(token, operatorHmacSecret);

		if (!result.ok) {
			// Map P472 result reasons to AC-27 status codes
			let status = 401;
			let reason = result.reason ?? "invalid_sig";

			if (
				result.reason === "token_expired" ||
				result.reason === "principal_expired"
			) {
				status = 401;
				reason = "token_expired";
			} else if (result.reason === "token_principal_mismatch") {
				status = 403;
				reason = "sub_mismatch";
			}

			return {
				valid: false,
				status,
				reason,
			};
		}

		// Token verified, now check sub claim matches expectedFromAgent
		// P472 verifyBoundBearer returns the token payload
		// We need to extract the principal_id (sub claim) and compare
		if (result.principal_id !== expectedFromAgent) {
			return {
				valid: false,
				status: 403,
				reason: "sub_mismatch",
			};
		}

		return { valid: true };
	} catch (err) {
		return {
			valid: false,
			status: 401,
			reason: "invalid_sig",
		};
	}
}
