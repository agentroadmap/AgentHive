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

export type OfferKind = "gate-review" | "enhance" | "review" | "develop" | "merge";

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
