// P477 AC-7: Control-plane operator authorization.
//
// Single-purpose middleware for privileged web actions. Read endpoints
// stay open; only callers that mutate live state (stop runaway agents,
// kill cubics, send DMs, future state-machine controls) go through
// `requireOperator()`.
//
// Default posture is FAIL-CLOSED: if `roadmap.operator_token` is empty
// every privileged call returns 503 "operator auth not configured".
// This means deploying the table without inserting a token does not
// silently expose endpoints.
//
// Authentication = SHA-256 hash of the bearer token compared against
// `operator_token.token_sha256`. Authorization = `allowed_actions`
// list (use `'*'` for full powers).
//
// Every call writes one row to `roadmap.operator_audit_log` regardless
// of decision so the audit trail is the source of truth for AC-4 review.

import { createHash } from "node:crypto";
import { query } from "../../infra/postgres/pool.ts";

export type OperatorAuthDecision =
	| "allow"
	| "deny"
	| "anonymous"
	| "unconfigured";

export interface OperatorAuthOutcome {
	decision: OperatorAuthDecision;
	operatorName: string | null;
	tokenId: number | null;
	failureReason: string | null;
	httpStatus: number;
}

export interface OperatorAuthContext {
	action: string;
	targetKind?: string;
	targetIdentity?: string;
	requestSummary?: Record<string, unknown>;
}

export function hashOperatorToken(rawToken: string): string {
	return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function extractBearer(req: Request): string | null {
	const header = req.headers.get("authorization") ?? "";
	const m = /^Bearer\s+(\S+)/i.exec(header);
	if (m) return m[1];
	const xToken = req.headers.get("x-operator-token");
	if (xToken && xToken.trim().length > 0) return xToken.trim();
	return null;
}

function clientIp(req: Request): string | null {
	const xff = req.headers.get("x-forwarded-for");
	if (xff) return xff.split(",")[0].trim();
	return req.headers.get("x-real-ip");
}

async function logAudit(args: {
	action: string;
	decision: OperatorAuthDecision;
	operatorName: string | null;
	tokenId: number | null;
	targetKind?: string;
	targetIdentity?: string;
	requestSummary?: Record<string, unknown>;
	remoteAddr: string | null;
	responseStatus: number;
	failureReason: string | null;
}): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.operator_audit_log
			   (operator_name, token_id, action, decision,
			    target_kind, target_identity, request_summary,
			    remote_addr, response_status, failure_reason)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
			[
				args.operatorName,
				args.tokenId,
				args.action,
				args.decision,
				args.targetKind ?? null,
				args.targetIdentity ?? null,
				JSON.stringify(args.requestSummary ?? {}),
				args.remoteAddr,
				args.responseStatus,
				args.failureReason,
			],
		);
	} catch (err) {
		// Auditing must never block the request path.
		console.error("[operator-auth] audit insert failed:", (err as Error).message);
	}
}

/**
 * Authorize an operator-level request and write an audit row.
 *
 * Returns an OperatorAuthOutcome describing the decision. Callers
 * inspect `decision`/`httpStatus`; if not `"allow"`, do NOT proceed
 * with the privileged action — return a Response.json error using the
 * recommended status.
 */
export async function authorizeOperator(
	req: Request,
	ctx: OperatorAuthContext,
): Promise<OperatorAuthOutcome> {
	const remoteAddr = clientIp(req);

	// 1. Are any tokens configured at all?
	const { rows: configRows } = await query<{ token_count: number | string }>(
		`SELECT COUNT(*)::int AS token_count
		   FROM roadmap.operator_token
		  WHERE revoked_at IS NULL
		    AND (expires_at IS NULL OR expires_at > now())`,
	);
	const activeTokenCount = Number(configRows[0]?.token_count ?? 0);

	if (activeTokenCount === 0) {
		const out: OperatorAuthOutcome = {
			decision: "unconfigured",
			operatorName: null,
			tokenId: null,
			failureReason: "No active operator_token rows configured.",
			httpStatus: 503,
		};
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: null,
			tokenId: null,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	// 2. Bearer token present?
	const raw = extractBearer(req);
	if (!raw) {
		const out: OperatorAuthOutcome = {
			decision: "anonymous",
			operatorName: null,
			tokenId: null,
			failureReason: "Missing Authorization: Bearer <token> header.",
			httpStatus: 401,
		};
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: null,
			tokenId: null,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	const sha = hashOperatorToken(raw);

	// 3. Lookup + check action allowlist + revocation/expiry.
	const { rows } = await query<{
		id: number;
		operator_name: string;
		allowed_actions: string[];
		revoked_at: string | null;
		expires_at: string | null;
	}>(
		`SELECT id, operator_name, allowed_actions, revoked_at, expires_at
		   FROM roadmap.operator_token
		  WHERE token_sha256 = $1`,
		[sha],
	);

	const row = rows[0];
	const denyOutcome = (reason: string, status = 403): OperatorAuthOutcome => ({
		decision: "deny",
		operatorName: row?.operator_name ?? null,
		tokenId: row?.id ?? null,
		failureReason: reason,
		httpStatus: status,
	});

	if (!row) {
		const out = denyOutcome("Token not recognized.", 401);
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: out.operatorName,
			tokenId: out.tokenId,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	if (row.revoked_at) {
		const out = denyOutcome("Token revoked.");
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: out.operatorName,
			tokenId: out.tokenId,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
		const out = denyOutcome("Token expired.");
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: out.operatorName,
			tokenId: out.tokenId,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	const allowed = row.allowed_actions ?? [];
	const actionAllowed = allowed.includes("*") || allowed.includes(ctx.action);
	if (!actionAllowed) {
		const out = denyOutcome(
			`Action '${ctx.action}' not in allowed_actions for operator '${row.operator_name}'.`,
		);
		await logAudit({
			action: ctx.action,
			decision: out.decision,
			operatorName: out.operatorName,
			tokenId: out.tokenId,
			targetKind: ctx.targetKind,
			targetIdentity: ctx.targetIdentity,
			requestSummary: ctx.requestSummary,
			remoteAddr,
			responseStatus: out.httpStatus,
			failureReason: out.failureReason,
		});
		return out;
	}

	// allowed
	void query(
		`UPDATE roadmap.operator_token SET last_used_at = now() WHERE id = $1`,
		[row.id],
	).catch(() => {
		// best-effort, never block the request
	});

	const out: OperatorAuthOutcome = {
		decision: "allow",
		operatorName: row.operator_name,
		tokenId: row.id,
		failureReason: null,
		httpStatus: 200,
	};
	await logAudit({
		action: ctx.action,
		decision: out.decision,
		operatorName: out.operatorName,
		tokenId: out.tokenId,
		targetKind: ctx.targetKind,
		targetIdentity: ctx.targetIdentity,
		requestSummary: ctx.requestSummary,
		remoteAddr,
		responseStatus: 200,
		failureReason: null,
	});
	return out;
}

/**
 * Convenience helper: run authorizeOperator() and translate non-"allow"
 * outcomes into a Response. Returns null when the call should proceed.
 */
export async function requireOperator(
	req: Request,
	ctx: OperatorAuthContext,
): Promise<{ outcome: OperatorAuthOutcome; rejected: Response | null }> {
	const outcome = await authorizeOperator(req, ctx);
	if (outcome.decision === "allow") {
		return { outcome, rejected: null };
	}
	const message =
		outcome.decision === "unconfigured"
			? "Operator auth is not configured. Insert a row into roadmap.operator_token to enable privileged actions."
			: outcome.failureReason ?? "Forbidden";
	const rejected = Response.json(
		{
			error: message,
			decision: outcome.decision,
			action: ctx.action,
		},
		{ status: outcome.httpStatus },
	);
	return { outcome, rejected };
}
