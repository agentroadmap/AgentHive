/**
 * P3840: Unified dispatch pool builder.
 *
 * Queries v_unified_dispatch_pool to produce a ranked list of proposals that
 * each need exactly one offer posted. Mature proposals sort first (they need
 * gate-review offers); within each maturity bucket, oldest-modified goes first
 * to prevent starvation.
 */

import { query } from "../../infra/postgres/pool.ts";

export type OfferKind = "enhance" | "review" | "develop" | "merge" | "gate-review";

export interface DispatchPoolRow {
	id: number;
	displayId: string;
	status: string;
	maturity: string;
	offerKind: OfferKind;
	type: string;
	title: string;
}

/**
 * Fetch up to `limit` proposals from the unified dispatch pool, ranked by:
 *   1. Mature proposals first (gate-review unblocks the pipeline).
 *   2. Oldest modified_at within each maturity bucket (FIFO fairness).
 *
 * The view already excludes paused, obsolete, terminal, and live-dispatched
 * proposals — callers need no additional filtering.
 */
export async function buildUnifiedPool(
	limit: number,
): Promise<DispatchPoolRow[]> {
	const { rows } = await query<{
		id: number;
		display_id: string;
		status: string;
		maturity: string;
		offer_kind: OfferKind;
		type: string;
		title: string;
	}>(
		`SELECT id,
		        display_id,
		        status,
		        maturity,
		        offer_kind,
		        type,
		        title
		   FROM roadmap_proposal.v_unified_dispatch_pool
		  WHERE offer_kind IS NOT NULL
		  ORDER BY
		       (maturity = 'mature') DESC,
		       modified_at ASC NULLS LAST
		  LIMIT $1`,
		[limit],
	);

	return rows.map((r) => ({
		id: r.id,
		displayId: r.display_id,
		status: r.status,
		maturity: r.maturity,
		offerKind: r.offer_kind,
		type: r.type,
		title: r.title,
	}));
}
