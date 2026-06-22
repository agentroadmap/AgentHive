/**
 * P3840: Unified dispatch pool builder.
 *
 * Queries v_unified_dispatch_pool — all non-terminal, non-paused, non-obsolete
 * proposals without an active squad_dispatch offer — and returns them with an
 * offer_kind tag that drives routing in scanQueues().
 *
 * Active-dispatch guard is in the view (dispatch.id IS NULL), so this module
 * only needs to fetch and return rows. No lease acquisition here; postWorkOffer
 * and dispatchImplicitGate handle single-flight semantics via squad_dispatch
 * dedup constraints and proposal_lease respectively.
 */

import { query } from "../../infra/postgres/pool.ts";

/**
 * Offer taxonomy.
 *
 * `decide` (P4996, V3.1-S1): gate-DECISION work — an offer for an agency to
 * RECORD the gate decision (advance/hold/reject) on a proposal, as distinct from
 * `gate-review` (the review/validation pass that precedes it). A `decide` offer is
 * subject to the builder≠decider claim-time independence invariant: the agency
 * that built the proposal may not claim its decide offer (flag-gated, default OFF;
 * AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED). The orchestrator continues
 * to tag mature proposals `gate-review`; `decide` is the kind the claim/push paths
 * recognize for the independence gate. Adding it here is behavior-neutral until the
 * flag is flipped.
 */
export type OfferKind =
	| "gate-review"
	| "decide"
	| "enhance"
	| "review"
	| "develop"
	| "merge";

/**
 * P4996: dispatch roles / offer kinds that constitute gate-DECISION ("decide")
 * work. Kept in sync with roadmap_proposal.fn_claim_is_decide_offer (migration
 * 316). Used by the push-path independence mirror in offer-dispatch-handler.ts.
 */
export const DECIDE_OFFER_ROLES: ReadonlySet<string> = new Set([
	"gate_decision_agent",
	"merge_decision_agent",
	"gate-reviewer",
	"gate-decider",
	"decide",
	"decider",
]);

/** P4996: returns true when an offer role/kind denotes gate-decision work. */
export function isDecideOfferRole(role: string | null | undefined): boolean {
	if (!role) return false;
	return DECIDE_OFFER_ROLES.has(role.toLowerCase());
}

export interface UnifiedPoolRow {
	id: number;
	display_id: string;
	type: string;
	title: string;
	status: string;
	maturity: string;
	offer_kind: OfferKind;
}

/**
 * Fetch the current unified dispatch pool — proposals needing a work offer or
 * gate-review offer — ordered oldest-first for fairness.
 *
 * @param limit  Max rows to return (default: 20, matches scanBatchLimit default).
 */
export async function buildUnifiedPool(limit: number = 20): Promise<UnifiedPoolRow[]> {
	const { rows } = await query<{
		id: number;
		display_id: string;
		type: string;
		title: string;
		status: string;
		maturity: string;
		offer_kind: string;
	}>(
		`SELECT
		    id,
		    display_id,
		    type,
		    title,
		    status,
		    maturity,
		    offer_kind
		 FROM roadmap_proposal.v_unified_dispatch_pool
		 ORDER BY created_at ASC, id ASC
		 LIMIT $1`,
		[limit],
	);

	return rows
		.filter((r) => r.offer_kind != null)
		.map((r) => ({
			id: r.id,
			display_id: r.display_id,
			type: r.type,
			title: r.title,
			status: r.status,
			maturity: r.maturity,
			offer_kind: r.offer_kind as OfferKind,
		}));
}
