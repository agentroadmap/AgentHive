/**
 * P3313 AC-1: Write adaptive-matcher columns to route_decision_log.
 *
 * Two usage modes:
 *
 * 1. Inline: pass adaptiveCtx to writeRouteDecision() to do a single INSERT
 *    with all P772 + P3313 columns in one shot (preferred when available).
 *
 * 2. Patch: call patchAdaptiveColumns() after the P772 INSERT (written by
 *    logRouteDecision in agent-spawner.ts) when adaptive context is computed
 *    later — identified by (proposal_id, chosen_route_id, decided_at window).
 *
 * The tier-aware-resolver bug (roadmap_workforce.route_decision_log) is also
 * documented here as it must be fixed before shipping AC-1.
 */

import { query as _poolQuery } from "../../infra/postgres/pool.ts";

// Test injection hook — replaced by test suite via _setQueryForTest().
let _query: typeof _poolQuery = _poolQuery;
export function _setQueryForTest(fn: typeof _poolQuery): void {
  _query = fn;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface P772Columns {
  proposalId: number | null;
  role: string | null;
  agencyIdentity: string | null;
  chosenRouteId: number;
  eliminatedRoutes?: Array<{ route_id: number; route_provider: string; reason: string }>;
}

export interface AdaptiveMatchColumns {
  /** [0,1] difficulty score from P3310 difficulty assessor */
  difficultyScore?: number | null;
  /** 'free'|'lower'|'mid'|'frontier' — min tier derived from difficulty */
  requiredTier?: string | null;
  /** [0,1] reliability score of chosen route for this task_class (P3311) */
  reliabilityScore?: number | null;
  /** 1-based rank by cost among eligible candidates (1=cheapest) */
  costRank?: number | null;
  /** human-readable rationale for why this route was selected */
  chosenReason?: string | null;
  /** task classification at match time */
  taskClass?: string | null;
}

export type DecisionLogRow = P772Columns & AdaptiveMatchColumns;

// ---------------------------------------------------------------------------
// Mode 1: full INSERT with all columns
// ---------------------------------------------------------------------------

/**
 * Insert one route_decision_log row including all P3313 adaptive columns.
 * Use this when matchWorkToRoute context is available at route-selection time.
 * Fire-and-forget safe — never throws; caller should .catch() if needed.
 */
export async function writeRouteDecision(row: DecisionLogRow): Promise<void> {
  const elim = row.eliminatedRoutes ? JSON.stringify(row.eliminatedRoutes) : null;
  await _query(
    `INSERT INTO roadmap.route_decision_log
       (proposal_id, role, agency_identity, chosen_route_id, eliminated_routes,
        difficulty_score, required_tier, reliability_score, cost_rank, chosen_reason, task_class)
     VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9,$10,$11)`,
    [
      row.proposalId,
      row.role,
      row.agencyIdentity,
      row.chosenRouteId,
      elim,
      row.difficultyScore ?? null,
      row.requiredTier ?? null,
      row.reliabilityScore ?? null,
      row.costRank ?? null,
      row.chosenReason ?? null,
      row.taskClass ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Mode 2: patch after the fact
// ---------------------------------------------------------------------------

/**
 * Patch the most recent route_decision_log row for this (proposalId, chosenRouteId)
 * pair with adaptive-matcher columns.  Only writes columns that are provided
 * (non-undefined) and only when the target row still has them NULL (idempotent).
 *
 * Returns true if a row was updated, false if none matched or already populated.
 *
 * P3312 calls this after matchWorkToRoute() returns when the legacy logRouteDecision
 * path already fired.
 */
export async function patchAdaptiveColumns(
  proposalId: number | null,
  chosenRouteId: number,
  ctx: AdaptiveMatchColumns,
): Promise<boolean> {
  // Only patch rows written in the last 60 s to avoid stale matches.
  const { rowCount } = await _query(
    `UPDATE roadmap.route_decision_log
     SET
       difficulty_score  = COALESCE(difficulty_score,  $3::NUMERIC),
       required_tier     = COALESCE(required_tier,     $4::TEXT),
       reliability_score = COALESCE(reliability_score, $5::NUMERIC),
       cost_rank         = COALESCE(cost_rank,         $6::SMALLINT),
       chosen_reason     = COALESCE(chosen_reason,     $7::TEXT),
       task_class        = COALESCE(task_class,        $8::TEXT)
     WHERE id = (
       SELECT id FROM roadmap.route_decision_log
       WHERE chosen_route_id = $1
         AND ($2::INTEGER IS NULL OR proposal_id = $2)
         AND decided_at > now() - INTERVAL '60 seconds'
       ORDER BY decided_at DESC
       LIMIT 1
     )`,
    [
      chosenRouteId,
      proposalId,
      ctx.difficultyScore ?? null,
      ctx.requiredTier ?? null,
      ctx.reliabilityScore ?? null,
      ctx.costRank ?? null,
      ctx.chosenReason ?? null,
      ctx.taskClass ?? null,
    ],
  );

  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Operator dashboard helpers (AC-5)
// ---------------------------------------------------------------------------

export interface RouteDecisionStats {
  task_class: string;
  route_id: number;
  route_provider: string;
  avg_reliability: number;
  decision_count: number;
  last_seen: string;
}

/**
 * Return per-task_class, per-route summary for the operator dashboard.
 * Limited to the last 7 days; ordered by task_class + decision count desc.
 */
export async function getRouteDecisionStats(windowDays = 7): Promise<RouteDecisionStats[]> {
  const { rows } = await _query<RouteDecisionStats>(
    `SELECT
       rdl.task_class,
       rdl.chosen_route_id   AS route_id,
       mr.route_provider,
       ROUND(AVG(rdl.reliability_score)::NUMERIC, 3) AS avg_reliability,
       COUNT(*)              AS decision_count,
       MAX(rdl.decided_at)   AS last_seen
     FROM roadmap.route_decision_log rdl
     JOIN roadmap.model_routes mr ON mr.id = rdl.chosen_route_id
     WHERE rdl.task_class IS NOT NULL
       AND rdl.decided_at > now() - ($1 || ' days')::INTERVAL
     GROUP BY rdl.task_class, rdl.chosen_route_id, mr.route_provider
     ORDER BY rdl.task_class, decision_count DESC`,
    [windowDays],
  );
  return rows;
}
