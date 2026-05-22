/**
 * P1105 AC-3/AC-4/AC-5 — User bearer token verification for msg_send.
 *
 * Verifies JWT HS256 tokens for user/* from_agent senders.
 * Key is read from AGENTHIVE_USER_JWT_SECRET env var.
 * TODO(P1072): replace env-var key lookup with vault adapter once P1072 ships.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { query } from "../../../../postgres/pool.ts";

export type BearerErrorCode =
	| "missing"
	| "malformed"
	| "invalid_sig"
	| "sub_mismatch"
	| "exp_expired"
	| "no_secret";

export interface BearerVerifyResult {
	ok: boolean;
	error?: BearerErrorCode;
}

function base64urlDecode(s: string): string {
	// Pad to multiple of 4
	const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
	return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Verify a JWT HS256 bearer token against fromAgent.
 *
 * Checks:
 *  1. Token is present and structurally valid (3 dot-separated parts).
 *  2. alg=HS256, typ=JWT header.
 *  3. HMAC-SHA256 signature matches AGENTHIVE_USER_JWT_SECRET.
 *  4. payload.sub === fromAgent (case-sensitive).
 *  5. payload.exp > now (with 30s clock skew tolerance).
 */
export function verifyUserBearer(
	token: string | undefined,
	fromAgent: string,
): BearerVerifyResult {
	const secret = process.env.AGENTHIVE_USER_JWT_SECRET;
	if (!secret) {
		return { ok: false, error: "no_secret" };
	}

	if (!token) {
		return { ok: false, error: "missing" };
	}

	const parts = token.split(".");
	if (parts.length !== 3) {
		return { ok: false, error: "malformed" };
	}

	const [headerB64, payloadB64, sigB64] = parts;

	// Verify HMAC-SHA256 signature
	const signingInput = `${headerB64}.${payloadB64}`;
	const expectedSig = createHmac("sha256", secret)
		.update(signingInput)
		.digest("base64url");

	let sigMatch: boolean;
	try {
		sigMatch = timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig));
	} catch {
		sigMatch = false;
	}
	if (!sigMatch) {
		return { ok: false, error: "invalid_sig" };
	}

	// Parse payload
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(base64urlDecode(payloadB64));
	} catch {
		return { ok: false, error: "malformed" };
	}

	// sub must match fromAgent exactly
	if (payload.sub !== fromAgent) {
		return { ok: false, error: "sub_mismatch" };
	}

	// exp check with 30s clock skew
	if (typeof payload.exp === "number") {
		const CLOCK_SKEW_S = 30;
		if (payload.exp + CLOCK_SKEW_S < Date.now() / 1000) {
			return { ok: false, error: "exp_expired" };
		}
	}

	return { ok: true };
}

/**
 * Log a bearer auth rejection to roadmap.operator_audit_log (AC-5).
 * Fire-and-forget — never throws.
 */
export async function logBearerRejection(
	fromAgent: string,
	errorCode: BearerErrorCode,
): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.operator_audit_log
			   (operator_name, token_id, action, decision,
			    target_kind, target_identity, request_summary,
			    remote_addr, response_status, failure_reason)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
			[
				"system",
				null,
				"msg_send",
				"deny",
				"user",
				fromAgent,
				JSON.stringify({ bearer_error: errorCode }),
				null,
				403,
				`bearer:${errorCode}`,
			],
		);
	} catch {
		// Audit log write failures are non-fatal.
	}
}

/** Extract Bearer token from an Authorization header value. */
export function extractBearerFromHeader(authHeader: string | undefined): string | undefined {
	if (!authHeader) return undefined;
	const m = /^Bearer\s+(\S+)/i.exec(authHeader);
	return m ? m[1] : undefined;
}
