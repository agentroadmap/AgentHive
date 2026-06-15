/**
 * P1376-AC2: Resolver integration for merged throttle checking.
 *
 * Provides a SQL WHERE clause generator and runtime filter that uses the
 * throttle_until_merged view to enforce a unified cooldown check across
 * both proactive (agency_capacity.reset_at) and reactive (model_routes.cooldown_until)
 * sources.
 *
 * Replaces separate column checks with a single predicate:
 * WHERE computed_throttle_until <= NOW()
 */

import { query as _pgQuery } from "../../../infra/postgres/pool.ts";

type QueryFn = typeof _pgQuery;
let _query: QueryFn = _pgQuery;

export function _setQueryForTest(fn: QueryFn): void {
  _query = fn;
}

function query(...args: Parameters<QueryFn>) {
  return _query(...args);
}

export interface ThrottleStatus {
  provider: string;
  model: string;
  agencyId: string;
  computedThrottleUntil: Date | null;
  throttleSource: 'proactive' | 'reactive' | 'both' | 'none';
  isThrottled: boolean;
}

/**
 * P1376-AC2: Check if an agency+provider+model tuple is throttled using the merged view.
 * Returns throttle status including source attribution for audit logging.
 *
 * Queries throttle_until_merged view which merges:
 * - Proactive: agency_capacity.reset_at
 * - Reactive: model_routes.cooldown_until
 * Using GREATEST to preserve the longer window.
 */
export async function checkMergedThrottle(
  provider: string,
  model: string,
  agencyId: string
): Promise<ThrottleStatus> {
  try {
    // P1376-AC2: Query merged throttle with fallback to model_routes for reactive-only scenarios
    // First try agency_capacity (includes join to model_routes via view)
    const { rows } = await query<{
      reset_at: string | null;
      cooldown_until: string | null;
      source: string;
    }>(
      `SELECT
         ac.reset_at,
         mr.cooldown_until,
         CASE
           WHEN (ac.reset_at IS NOT NULL) AND (mr.cooldown_until IS NOT NULL) AND (ac.reset_at > mr.cooldown_until) THEN 'proactive'
           WHEN (ac.reset_at IS NOT NULL) AND (mr.cooldown_until IS NOT NULL) AND (mr.cooldown_until > ac.reset_at) THEN 'reactive'
           WHEN (ac.reset_at IS NOT NULL) AND (mr.cooldown_until IS NOT NULL) THEN 'both'
           WHEN (ac.reset_at IS NOT NULL) THEN 'proactive'
           WHEN (mr.cooldown_until IS NOT NULL) THEN 'reactive'
           ELSE 'none'
         END as source
       FROM roadmap_workforce.agency_capacity ac
       LEFT JOIN roadmap.model_routes mr
         ON mr.route_provider = ac.provider AND mr.model_name = ac.model
       WHERE ac.provider = $1 AND ac.model = $2 AND ac.agency_id = $3
       UNION ALL
       SELECT
         NULL as reset_at,
         mr.cooldown_until,
         'reactive'
       FROM roadmap.model_routes mr
       WHERE mr.route_provider = $1 AND mr.model_name = $2
         AND NOT EXISTS (
           SELECT 1 FROM roadmap_workforce.agency_capacity ac
           WHERE ac.provider = $1 AND ac.model = $2 AND ac.agency_id = $3
         )`,
      [provider, model, agencyId]
    );

    if (rows.length === 0) {
      // No throttle record; agency is healthy
      return {
        provider,
        model,
        agencyId,
        computedThrottleUntil: null,
        throttleSource: 'none',
        isThrottled: false,
      };
    }

    const row = rows[0];
    const resetAt = row.reset_at ? new Date(row.reset_at) : null;
    const cooldownUntil = row.cooldown_until
      ? new Date(row.cooldown_until)
      : null;
    const computedThrottleUntil =
      resetAt && cooldownUntil
        ? resetAt > cooldownUntil
          ? resetAt
          : cooldownUntil
        : resetAt || cooldownUntil;
    const now = new Date();
    const isThrottled =
      computedThrottleUntil !== null && computedThrottleUntil > now;

    return {
      provider,
      model,
      agencyId,
      computedThrottleUntil,
      throttleSource: row.source as
        | 'proactive'
        | 'reactive'
        | 'both'
        | 'none',
      isThrottled,
    };
  } catch (err) {
    console.warn(
      `[P1376] Failed to check merged throttle for ${provider}/${model}/${agencyId}:`,
      err
    );
    // Fail open: assume not throttled if query fails
    return {
      provider,
      model,
      agencyId,
      computedThrottleUntil: null,
      throttleSource: 'none',
      isThrottled: false,
    };
  }
}

/**
 * P1376-AC2: SQL WHERE clause for the resolver's main agency selection query.
 *
 * Excludes agencies that are throttled (computed_throttle_until > NOW())
 * using the merged throttle view. This replaces separate checks of
 * agency_capacity and model_routes.
 *
 * Usage in a WHERE clause:
 *   WHERE {throttledFilterSql()}
 */
export function throttledFilterSql(
  providerParamIdx: number,
  modelParamIdx: number,
  agencyIdParamIdx: number,
  alias = 'pr'
): string {
  return `NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.throttle_until_merged tm
    WHERE tm.provider = $${providerParamIdx}
      AND tm.model = $${modelParamIdx}
      AND tm.agency_id = $${agencyIdParamIdx}
      AND tm.computed_throttle_until > NOW()
  )`;
}
