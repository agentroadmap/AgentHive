/**
 * P1105 Phase D — Bearer-token lifecycle: issuance + key rotation.
 *
 * Provides the deterministic core for two MCP tools:
 *   - token_issue  (AC-7 / AC-13): mint a stateless HS256 JWT for a user/*
 *                   identity with claims {sub, aud, exp, iat, key_id}.
 *   - token_rotate (AC-10 / AC-15): insert a fresh signing-key row into
 *                   roadmap.agent_token_key, leaving the prior key valid until
 *                   its own expires_at (rotation grace window).
 *
 * SECURITY — caller authorization (AC-17):
 *   Both operations are operator-gated. Only a verified principal of kind
 *   'operator' (carried in AgentContext via AsyncLocalStorage) may issue or
 *   rotate a token for a user/* identity. A non-operator caller is rejected
 *   with 403 and the attempt is audited. This is what stops any MCP caller
 *   from minting a valid operator/user token and defeating the threat model.
 *
 * KEY SOURCE (AC-17): tokens are signed with AGENTHIVE_USER_JWT_SECRET — the
 *   SAME secret verifyUserBearer() validates against — so there is exactly one
 *   authoritative verifier, no parallel key path. agent_token_key.secret_key_hash
 *   is rotation bookkeeping (which key_id is active, and its grace window); the
 *   signing secret itself is never persisted.
 */

import { createHmac } from "node:crypto";
import { query } from "../../../../infra/postgres/pool.ts";
import { agentContextStorage } from "../../../../shared/identity/agent-context.ts";

/** JWT audience all msg_send bearer tokens are scoped to. */
export const TOKEN_AUDIENCE = "agenthive-msg-send";

/** Default token lifetime when ttl_seconds is omitted. */
export const DEFAULT_TTL_SECONDS = 3600;
/** Hard ceiling on requested ttl_seconds (matches verifier's 3600s window). */
export const MAX_TTL_SECONDS = 3600;

/** Rotation grace window: a rotated-out key stays active for 30 days. */
export const ROTATION_GRACE_DAYS = 30;

export interface TokenIssueResult {
	ok: boolean;
	status: number;
	token?: string;
	key_id?: string;
	reason?: string;
}

export interface TokenRotateResult {
	ok: boolean;
	status: number;
	key_id?: string;
	reason?: string;
}

function base64url(input: string | Buffer): string {
	return Buffer.from(input).toString("base64url");
}

/** key_id for the current month, e.g. "2026-06". */
export function currentKeyId(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${y}-${m}`;
}

/**
 * AC-17 caller-authz gate. Returns null when authorized, otherwise a failure
 * result the handler should return verbatim. Only operator principals pass.
 */
function authorizeOperator():
	| { principal_id: string }
	| { reason: string } {
	const ctx = agentContextStorage.getStore();
	if (!ctx?.verified) {
		return { reason: "missing_operator_principal" };
	}
	if (ctx.verified.principal_kind !== "operator") {
		return { reason: "not_operator" };
	}
	return { principal_id: ctx.verified.principal_id };
}

async function auditTokenAction(
	action: "issue_token" | "rotate_token",
	decision: "allow" | "deny",
	targetIdentity: string,
	detail: Record<string, unknown>,
	responseStatus: number,
	failureReason: string | null,
): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.operator_audit_log
			   (operator_name, token_id, action, decision,
			    target_kind, target_identity, request_summary,
			    remote_addr, response_status, failure_reason)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
			[
				agentContextStorage.getStore()?.verified?.principal_id ?? "system",
				null,
				action,
				decision,
				"user",
				targetIdentity,
				JSON.stringify(detail),
				null,
				responseStatus,
				failureReason,
			],
		);
	} catch {
		// Audit write failures are non-fatal.
	}
}

/**
 * Issue a stateless HS256 JWT for a registered user/* identity.
 *
 * AC-7/AC-13: token decodes to {sub, aud='agenthive-msg-send', exp, iat, key_id}.
 * AC-17: operator-only; non-operator → 403, audited.
 */
export async function issueUserToken(args: {
	agent_identity?: string;
	ttl_seconds?: number;
}): Promise<TokenIssueResult> {
	const identity = (args.agent_identity ?? "").trim();

	const authz = authorizeOperator();
	if ("reason" in authz) {
		await auditTokenAction(
			"issue_token",
			"deny",
			identity || "(unspecified)",
			{ reason: authz.reason },
			403,
			`authz:${authz.reason}`,
		);
		return { ok: false, status: 403, reason: authz.reason };
	}

	if (!identity.startsWith("user/")) {
		await auditTokenAction(
			"issue_token",
			"deny",
			identity || "(unspecified)",
			{ reason: "not_user_identity" },
			400,
			"validation:not_user_identity",
		);
		return { ok: false, status: 400, reason: "not_user_identity" };
	}

	// Identity must be registered as a first-class USER in agent_registry.
	let registered = false;
	try {
		const r = await query(
			`SELECT 1 FROM roadmap_workforce.agent_registry
			  WHERE agent_identity = $1 AND agent_type = 'user' LIMIT 1`,
			[identity],
		);
		registered = r.rows.length > 0;
	} catch {
		registered = false;
	}
	if (!registered) {
		await auditTokenAction(
			"issue_token",
			"deny",
			identity,
			{ reason: "identity_not_registered" },
			404,
			"validation:identity_not_registered",
		);
		return { ok: false, status: 404, reason: "identity_not_registered" };
	}

	const secret = process.env.AGENTHIVE_USER_JWT_SECRET;
	if (!secret) {
		await auditTokenAction(
			"issue_token",
			"deny",
			identity,
			{ reason: "no_secret" },
			500,
			"config:no_secret",
		);
		return { ok: false, status: 500, reason: "no_secret" };
	}

	const ttl = Math.min(
		Math.max(1, Math.floor(args.ttl_seconds ?? DEFAULT_TTL_SECONDS)),
		MAX_TTL_SECONDS,
	);
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + ttl;
	const keyId = currentKeyId();

	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			sub: identity,
			aud: TOKEN_AUDIENCE,
			exp,
			iat,
			key_id: keyId,
		}),
	);
	const signingInput = `${header}.${payload}`;
	const sig = createHmac("sha256", secret)
		.update(signingInput)
		.digest("base64url");
	const token = `${signingInput}.${sig}`;

	await auditTokenAction(
		"issue_token",
		"allow",
		identity,
		{ ttl_seconds: ttl, key_id: keyId, exp },
		200,
		null,
	);

	return { ok: true, status: 200, token, key_id: keyId };
}

/**
 * Rotate the signing key for a user/* identity.
 *
 * AC-10/AC-15: inserts a new agent_token_key row keyed YYYY-MM with
 * expires_at = now() + 30d. The previously-active key row is left intact and
 * remains valid until its own expires_at (grace window).
 * AC-17: operator-only.
 */
export async function rotateUserToken(args: {
	agent_identity?: string;
	new_secret_hash?: string;
}): Promise<TokenRotateResult> {
	const identity = (args.agent_identity ?? "").trim();
	const newHash = (args.new_secret_hash ?? "").trim();

	const authz = authorizeOperator();
	if ("reason" in authz) {
		await auditTokenAction(
			"rotate_token",
			"deny",
			identity || "(unspecified)",
			{ reason: authz.reason },
			403,
			`authz:${authz.reason}`,
		);
		return { ok: false, status: 403, reason: authz.reason };
	}

	if (!identity.startsWith("user/")) {
		return { ok: false, status: 400, reason: "not_user_identity" };
	}
	if (!newHash) {
		return { ok: false, status: 400, reason: "missing_new_secret_hash" };
	}

	const keyId = currentKeyId();
	const expiresAt = new Date(
		Date.now() + ROTATION_GRACE_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();

	try {
		// Upsert: re-rotating within the same month refreshes the grace window
		// rather than colliding on the (agent_identity, key_id) PK.
		await query(
			`INSERT INTO roadmap.agent_token_key
			   (agent_identity, key_id, secret_key_hash, expires_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (agent_identity, key_id)
			 DO UPDATE SET secret_key_hash = EXCLUDED.secret_key_hash,
			               expires_at      = EXCLUDED.expires_at`,
			[identity, keyId, newHash, expiresAt],
		);
	} catch (err) {
		await auditTokenAction(
			"rotate_token",
			"deny",
			identity,
			{ reason: "db_error", message: String(err) },
			500,
			"db:insert_failed",
		);
		return { ok: false, status: 500, reason: "db_error" };
	}

	await auditTokenAction(
		"rotate_token",
		"allow",
		identity,
		{ key_id: keyId, expires_at: expiresAt },
		200,
		null,
	);

	return { ok: true, status: 200, key_id: keyId };
}
