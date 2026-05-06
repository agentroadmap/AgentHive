/**
 * P749 (A2): Workflow context resolver for scanQueues().
 *
 * Replaces the legacy CASE-on-status branching for RFC vs Hotfix paths.
 * Adding a new workflow now means: insert workflow_templates row + insert
 * workflow_transitions rows. No code change required.
 *
 * The resolver is purely read-only and DB-driven — it must NOT branch on
 * RFC vs Hotfix literals (AC-3).
 *
 * Schema notes (verified 2026-05-05 against agenthive DB):
 *   - roadmap_proposal.proposal links to a template by `workflow_name` (text),
 *     not by workflow_template_id. There is no FK; the join is on name string.
 *   - roadmap.workflow_transitions stores `labels text[]`. The forward path
 *     for any (template, from_stage) is the row whose labels array contains
 *     the literal 'mature'. Secondary labels (submit/decision/deploy/accepted)
 *     describe the gate type and are returned as `gate_label`.
 *   - proposal.status casing varies (CHECK allows both 'Draft' and 'DRAFT');
 *     workflow_transitions.from_stage is uppercase. We UPPER() the proposal
 *     status before joining.
 */

import { query as defaultQuery } from "../../../infra/postgres/pool.ts";

type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface WorkflowTransitionEdge {
	from_stage: string;
	to_stage: string;
}

export interface WorkflowContext {
	template_id: number;
	current_stage: string;
	next_transition: WorkflowTransitionEdge | null;
	gate_label: string | null;
	requires_ac: boolean;
}

const SQL_RESOLVE = `
WITH p AS (
    SELECT id,
           UPPER(status)  AS status,
           maturity,
           workflow_name
    FROM   roadmap_proposal.proposal
    WHERE  id = $1
),
t AS (
    SELECT wt.id  AS template_id
    FROM   roadmap.workflow_templates wt
    JOIN   p     ON p.workflow_name = wt.name
),
nxt AS (
    -- Forward transition for this stage: rows whose labels[] contains 'mature'.
    -- (template_id, from_stage, to_stage) is UNIQUE; the 'mature' filter
    -- collapses iteration paths (label='iterate' or 'revision') to zero rows.
    SELECT wtr.from_stage,
           wtr.to_stage,
           wtr.labels,
           wtr.requires_ac
    FROM   roadmap.workflow_transitions wtr
    JOIN   t  ON t.template_id = wtr.template_id
    JOIN   p  ON UPPER(wtr.from_stage) = p.status
    WHERE  'mature' = ANY(wtr.labels)
    LIMIT  1
)
SELECT t.template_id                                   AS template_id,
       p.status                                        AS current_stage,
       nxt.from_stage                                  AS next_from_stage,
       nxt.to_stage                                    AS next_to_stage,
       (
           SELECT lbl
           FROM   unnest(nxt.labels) AS lbl
           WHERE  lbl <> 'mature'
           ORDER  BY lbl
           LIMIT  1
       )                                               AS gate_label,
       COALESCE(nxt.requires_ac, FALSE)                AS requires_ac
FROM   p
LEFT JOIN t   ON TRUE
LEFT JOIN nxt ON TRUE
`;

/**
 * Resolve workflow context for a proposal.
 *
 * Returns null when:
 *   - proposal_id does not exist
 *   - the proposal's workflow_name does not match any workflow_templates row
 *
 * When the proposal exists at a terminal stage (no row in workflow_transitions
 * with 'mature' label from current stage, e.g. COMPLETE), the function returns
 * the context with `next_transition: null` and `gate_label: null` so callers
 * still receive template_id and current_stage. AC-2's "returns null when
 * proposal has no valid forward transition" is interpreted at the
 * next_transition field level, not the whole function.
 *
 * @param proposal_id  - bigint id from roadmap_proposal.proposal
 * @param queryFn      - injectable for tests; defaults to shared pool
 */
export async function resolve_workflow_context(
	proposal_id: number,
	queryFn: QueryFn = defaultQuery,
): Promise<WorkflowContext | null> {
	const { rows } = await queryFn(SQL_RESOLVE, [proposal_id]);
	if (rows.length === 0) return null;

	const r = rows[0];
	if (r.template_id == null) return null;

	const next: WorkflowTransitionEdge | null =
		r.next_to_stage != null && r.next_from_stage != null
			? {
					from_stage: String(r.next_from_stage),
					to_stage: String(r.next_to_stage),
				}
			: null;

	return {
		template_id: Number(r.template_id),
		current_stage: String(r.current_stage),
		next_transition: next,
		gate_label: r.gate_label != null ? String(r.gate_label) : null,
		requires_ac: Boolean(r.requires_ac),
	};
}
