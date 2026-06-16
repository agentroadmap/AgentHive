/**
 * P1391 — Verdict semantics v3 + gate-decision authorization.
 *
 * This module is the AUTHORITY layer for the destructive gate verdicts. It sits
 * on top of the structural lease slice (migration 287: lease_is_live, no-overlap
 * EXCLUDE, reaper retired) and the verdict-semantics CASE in the release trigger
 * (migration 290, this slice).
 *
 * Canonical gate vocabulary is exactly THREE verdicts when the flag is ON:
 *
 *   | verdict             | maturity   | status      | authority           |
 *   |---------------------|------------|-------------|---------------------|
 *   | advance             | next-stage | → next      | gate-agent (routine)|
 *   | request_for_change  | → 'new'    | unchanged   | gate-agent (routine)|
 *   | reject              | → 'obsolete'| unchanged  | ELEVATED            |
 *
 * `reject` (and the symmetric prop_set_maturity('obsolete')) is a TERMINAL
 * closure — the proposal exits the active corpus. It is authorized iff EITHER:
 *
 *   1. HUMAN OPERATOR — a valid operator_token (P3508 authorizeOperatorByToken,
 *      fail-closed, auto-audited). The human IS the authority: exempt from the
 *      frontier-model + structured-reference requirements below.
 *
 *   2. DELEGATED PERMANENT AGENT — the actor holds an ACTIVE authority_grant
 *      (grantee_id=actor, scope_category IN the relevant set, not revoked, not
 *      expired). For the AGENT reject path we additionally require BOTH:
 *        (a) frontier model — the reject-capable route resolves to the frontier
 *            constant (FRONTIER_GATE_ROUTE), AND
 *        (b) structured justification — a typed proposal_dependency edge
 *            ('superseded_by' and/or 'conflicts_with') PLUS obsoleted_reason text.
 *
 * FAIL-CLOSED: unknown/unregistered actor, no token + no grant, or
 * operator_token table empty + no grant ⇒ DENY. trust_tier alone is NOT
 * sufficient (the operator chose grant-based delegation, not raw trust_tier).
 *
 * Flag: AGENTHIVE_GATE_AUTHORITY_ENABLED (env>DB>default OFF). When OFF this
 * module is never consulted by the gate path (the caller keeps pre-P1391
 * behavior, and reject→obsolete is UNREACHABLE — no destructive close without
 * the guard).
 */

import { query } from "../../postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

/**
 * The single configurable frontier route. A DELEGATED AGENT may only originate a
 * reject when its reject-capable route resolves to this constant. The default is
 * `claude-opus-4-8`; override at runtime with AGENTHIVE_FRONTIER_GATE_ROUTE.
 *
 * Resolution order for the actor's effective route (first non-empty wins):
 *   1. roadmap_proposal.gate_role.model_preference for a reject-capable role
 *      (role IN gate-reviewer/architecture-reviewer) — the operator-curated
 *      route for the decision seat;
 *   2. roadmap_workforce.agent_registry.preferred_model for the deciding actor.
 */
export const FRONTIER_GATE_ROUTE: string =
	process.env.AGENTHIVE_FRONTIER_GATE_ROUTE?.trim() || "claude-opus-4-8";

/** scope_category values that authorize each elevated action. */
export const SCOPE_GATE_REJECT = "gate_reject";
export const SCOPE_PROPOSAL_OBSOLETE = "proposal_obsolete";

/** Typed dependency edges that count as structured reject justification. */
export const REJECT_REFERENCE_EDGES = ["superseded_by", "conflicts_with"] as const;

export type GateAuthorityAction = "gate.reject" | "proposal.obsolete";

export interface GateAuthorityResult {
	/** true ⇒ the elevated action is authorized; proceed. */
	allowed: boolean;
	/** The path that authorized (or would have) the action. */
	via: "operator" | "grant" | null;
	/** Programmatic refusal code (when !allowed). */
	code?:
		| "AUTHORITY_REQUIRED"
		| "OPERATOR_TOKEN_NOT_AUTHORIZED"
		| "GRANT_NOT_FOUND"
		| "REJECT_REQUIRES_REFERENCE"
		| "REJECT_REQUIRES_FRONTIER_MODEL";
	/** Human-readable reason. */
	reason?: string;
	/** operator_token id (audit linkage) when via='operator'. */
	tokenId?: number | null;
	/** authority_grant id when via='grant'. */
	grantId?: number | null;
}

/**
 * Resolve the P1391 master flag with the standard env>DB>default cascade. Fails
 * to OFF on any error so the gate path never wedges.
 */
export async function isGateAuthorityEnabled(): Promise<boolean> {
	const env = process.env.AGENTHIVE_GATE_AUTHORITY_ENABLED;
	if (env !== undefined) {
		return env === "1" || env.toLowerCase() === "true";
	}
	try {
		return (await runtimeConfig.get(FlagKeys.GATE_AUTHORITY_ENABLED)) === true;
	} catch {
		return false; // default OFF
	}
}

/** Count active (unrevoked, unexpired) operator tokens. */
async function activeOperatorTokenCount(): Promise<number> {
	const { rows } = await query<{ n: number | string }>(
		`SELECT COUNT(*)::int AS n
		   FROM roadmap.operator_token
		  WHERE revoked_at IS NULL
		    AND (expires_at IS NULL OR expires_at > now())`,
	);
	return Number(rows[0]?.n ?? 0);
}

/** Look up an ACTIVE authority_grant for an actor + one of the scope categories. */
async function findActiveGrant(
	actor: string,
	scopeCategories: string[],
): Promise<{ id: number; authority_level: string } | null> {
	const { rows } = await query<{ id: number; authority_level: string }>(
		`SELECT id, authority_level
		   FROM roadmap.authority_grant
		  WHERE grantee_id = $1
		    AND scope_category = ANY($2)
		    AND revoked_at IS NULL
		    AND (expires_at IS NULL OR expires_at > now())
		  ORDER BY created_at DESC
		  LIMIT 1`,
		[actor, scopeCategories],
	);
	return rows[0] ?? null;
}

/**
 * Resolve the deciding actor's effective gate route. First the operator-curated
 * gate_role.model_preference (reject-capable seats), then the actor's
 * agent_registry.preferred_model. Returns null when nothing resolves.
 */
async function resolveActorRoute(actor: string): Promise<string | null> {
	const { rows: roleRows } = await query<{ model_preference: string | null }>(
		`SELECT model_preference
		   FROM roadmap_proposal.gate_role
		  WHERE role IN ('gate-reviewer', 'architecture-reviewer')
		    AND model_preference IS NOT NULL
		    AND length(trim(model_preference)) > 0
		  ORDER BY id
		  LIMIT 1`,
	);
	const fromRole = roleRows[0]?.model_preference?.trim();
	if (fromRole) return fromRole;

	const { rows: regRows } = await query<{ preferred_model: string | null }>(
		`SELECT preferred_model
		   FROM roadmap_workforce.agent_registry
		  WHERE agent_identity = $1
		  LIMIT 1`,
		[actor],
	);
	const fromReg = regRows[0]?.preferred_model?.trim();
	return fromReg && fromReg.length > 0 ? fromReg : null;
}

/**
 * A9: does the proposal carry a structured reject justification? Requires a
 * typed proposal_dependency edge ('superseded_by' and/or 'conflicts_with')
 * originating from this proposal, PLUS non-empty obsoleted_reason text.
 */
async function hasRejectReference(numericProposalId: number): Promise<boolean> {
	const { rows: edgeRows } = await query<{ n: number | string }>(
		`SELECT COUNT(*)::int AS n
		   FROM roadmap_proposal.proposal_dependencies
		  WHERE from_proposal_id = $1
		    AND dependency_type = ANY($2)`,
		[numericProposalId, REJECT_REFERENCE_EDGES as unknown as string[]],
	);
	if (Number(edgeRows[0]?.n ?? 0) === 0) return false;

	const { rows: reasonRows } = await query<{ obsoleted_reason: string | null }>(
		`SELECT obsoleted_reason
		   FROM roadmap_proposal.proposal
		  WHERE id = $1`,
		[numericProposalId],
	);
	return (reasonRows[0]?.obsoleted_reason ?? "").trim().length > 0;
}

/**
 * Authorize an elevated reject / obsolete action.
 *
 * Call this ONLY when the master flag is ON (the caller checks
 * isGateAuthorityEnabled first; when OFF the destructive path is unreachable).
 *
 * @param action          'gate.reject' or 'proposal.obsolete' (audit action + scope mapping)
 * @param numericProposalId resolved numeric proposal id (audit target + reference lookup)
 * @param actor           the deciding identity (decided_by / maturity actor)
 * @param operatorToken   operator token string (MCP arg), if any → HUMAN OPERATOR path
 * @param targetProjectId optional project scope (P3508 AC-5 passthrough)
 */
export async function authorizeRejectOrObsolete(args: {
	action: GateAuthorityAction;
	numericProposalId: number;
	actor: string;
	operatorToken?: string | null;
	targetProjectId?: number;
}): Promise<GateAuthorityResult> {
	const scopeCategories =
		args.action === "gate.reject"
			? [SCOPE_GATE_REJECT, SCOPE_PROPOSAL_OBSOLETE]
			: [SCOPE_PROPOSAL_OBSOLETE, SCOPE_GATE_REJECT];

	// ── Path 1: HUMAN OPERATOR (token). Exempt from frontier+reference (A11). ──
	if (args.operatorToken) {
		const { authorizeOperatorByToken } = await import(
			"../../apps/server/operator-auth.ts"
		);
		const outcome = await authorizeOperatorByToken(args.operatorToken, {
			action: args.action,
			targetKind: "proposal",
			targetIdentity: String(args.numericProposalId),
			targetProjectId: args.targetProjectId,
			requestSummary: { actor: args.actor },
		}).catch((err) => ({
			decision: "deny" as const,
			operatorName: null,
			tokenId: null,
			failureReason: (err as Error)?.message ?? "authorize error",
			httpStatus: 500,
		}));

		if (outcome.decision === "allow") {
			return { allowed: true, via: "operator", tokenId: outcome.tokenId ?? null };
		}
		// A token was PRESENTED but rejected. Do NOT silently fall through to the
		// grant path — a bad token is an explicit deny (fail-closed, audited).
		return {
			allowed: false,
			via: "operator",
			code: "OPERATOR_TOKEN_NOT_AUTHORIZED",
			tokenId: outcome.tokenId ?? null,
			reason:
				`${args.action} refused: operator_token not authorized ` +
				`(decision='${outcome.decision}'${outcome.failureReason ? `, ${outcome.failureReason}` : ""}). ` +
				`The token must be a valid, unrevoked operator_token whose allowed_actions ` +
				`permit '${args.action}' (P1391, fail-closed).`,
		};
	}

	// ── Path 2: DELEGATED PERMANENT AGENT (authority_grant). ──
	const grant = await findActiveGrant(args.actor, scopeCategories);
	if (!grant) {
		// Fail-closed: no token + no grant ⇒ DENY (A4). Distinguish the
		// no-authority-configured case in the message for operability.
		const tokenCount = await activeOperatorTokenCount().catch(() => 0);
		return {
			allowed: false,
			via: null,
			code: "AUTHORITY_REQUIRED",
			reason:
				`${args.action} refused: actor '${args.actor}' is not authorized. ` +
				`This is an ELEVATED action. Supply a valid operator_token (human operator), ` +
				`or hold an ACTIVE authority_grant ` +
				`(scope_category IN ${JSON.stringify(scopeCategories)}). ` +
				(tokenCount === 0
					? `No active operator_token rows are configured. `
					: ``) +
				`trust_tier alone is NOT sufficient (P1391, fail-closed, grant-based delegation).`,
		};
	}

	// For the AGENT path, only the reject side carries the additional frontier +
	// reference bars (A9/A10). proposal.obsolete via grant is the symmetric
	// terminal close; we apply the same bars so both doors are equally guarded.
	// (a) frontier model.
	const route = await resolveActorRoute(args.actor);
	if (route !== FRONTIER_GATE_ROUTE) {
		return {
			allowed: false,
			via: "grant",
			grantId: grant.id,
			code: "REJECT_REQUIRES_FRONTIER_MODEL",
			reason:
				`${args.action} refused: a delegated agent may only ${args.action} from the ` +
				`frontier route '${FRONTIER_GATE_ROUTE}'. Actor '${args.actor}' resolves to ` +
				`'${route ?? "(unresolved)"}'. A terminal closure must come from the frontier ` +
				`model (P1391 A10). A human operator_token is exempt from this bar.`,
		};
	}

	// (b) structured justification.
	const hasRef = await hasRejectReference(args.numericProposalId);
	if (!hasRef) {
		return {
			allowed: false,
			via: "grant",
			grantId: grant.id,
			code: "REJECT_REQUIRES_REFERENCE",
			reason:
				`${args.action} refused: a delegated agent reject requires structured ` +
				`justification. Add a typed proposal_dependency edge ` +
				`(${REJECT_REFERENCE_EDGES.join(" and/or ")}) to the replacing/conflicting ` +
				`proposal AND set obsoleted_reason text before rejecting (P1391 A9). A human ` +
				`operator_token is exempt from this bar.`,
		};
	}

	return { allowed: true, via: "grant", grantId: grant.id };
}
