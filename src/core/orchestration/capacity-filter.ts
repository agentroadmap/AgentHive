/**
 * P1365-AC4 / AC-8: Capacity-based agency filtering and scoring
 *
 * Integrates agency_capacity table into resolver ranking:
 * - Hard-throttled agencies excluded entirely
 * - Soft-throttled agencies scored down by (1 - p_skip)
 */

import { query as _pgQuery } from "../../infra/postgres/pool.ts";

type QueryFn = typeof _pgQuery;
let _query: QueryFn = _pgQuery;

export function _setQueryForTest(fn: QueryFn): void {
  _query = fn;
}

function query(...args: Parameters<QueryFn>) {
  return _query(...args);
}

export interface CapacityScore {
  action: 'none' | 'soft' | 'hard' | 'unknown';
  p_skip: number;
  headroom_pct: number | null;
  reset_at: Date | null;
}

/**
 * Compute throttle score multiplier for a candidate agency.
 * Returns 1.0 if no capacity record exists (assume healthy).
 * Returns 0.0 if hard-throttled (exclude from candidacy).
 * Returns (1 - p_skip) if soft-throttled (score down stochastically).
 */
export async function computeCapacityScoreMultiplier(
  agencyId: string,
  provider: string,
  model: string
): Promise<{ multiplier: number; score: CapacityScore }> {
  // Query agency_capacity for this (provider, model, agency_id) tuple.
  // P1365-AC2: fall back to the provider-level wildcard row (model='*') written
  // by the P1859 snapshot bridge when no exact model row exists; an exact match
  // always wins over the wildcard.
  const { rows } = await query(
    `SELECT throttle_action, p_skip, headroom_pct, reset_at
     FROM roadmap_workforce.agency_capacity
     WHERE provider = $1 AND (model = $2 OR model = '*') AND agency_id = $3
     ORDER BY CASE WHEN model = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [provider, model, agencyId]
  );

  // No record means healthy; full multiplier
  if (rows.length === 0) {
    return {
      multiplier: 1.0,
      score: {
        action: 'none',
        p_skip: 0,
        headroom_pct: null,
        reset_at: null,
      },
    };
  }

  const row = rows[0];
  const throttleAction = row.throttle_action as 'none' | 'soft' | 'hard' | 'unknown';
  const pSkip = parseFloat(row.p_skip || '0');
  const headroomPct = row.headroom_pct ? parseFloat(row.headroom_pct) : null;
  const resetAt = row.reset_at ? new Date(row.reset_at) : null;

  const score: CapacityScore = {
    action: throttleAction,
    p_skip: pSkip,
    headroom_pct: headroomPct,
    reset_at: resetAt,
  };

  switch (throttleAction) {
    case 'hard':
      // Exclude entirely
      return { multiplier: 0.0, score };
    case 'soft':
      // Score down by (1 - p_skip)
      return { multiplier: 1.0 - pSkip, score };
    case 'unknown':
    case 'none':
    default:
      // No throttle
      return { multiplier: 1.0, score };
  }
}

/**
 * Log a throttle decision to message_ledger for audit/observability
 * Called when a soft-throttle or hard-throttle decision affects spawn ranking
 *
 * P1376-AC5: throttle_source='proactive|reactive|both' identifies which cooldown
 * window(s) contributed to the final throttle decision. Enables audit trails to
 * distinguish proactive capacity exhaustion from reactive 429/quota backoff.
 */
export async function logThrottleDecision(
  agencyId: string,
  provider: string,
  model: string,
  score: CapacityScore,
  projectId: string | null,
  throttleSource: 'proactive' | 'reactive' | 'both' | 'none' = 'proactive'
): Promise<void> {
  const metadata = {
    agency_id: agencyId,
    provider,
    model,
    throttle_action: score.action,
    p_skip: score.p_skip,
    headroom_pct: score.headroom_pct,
    reset_at: score.reset_at?.toISOString() ?? null,
    throttle_source: throttleSource,
    reason: score.action === 'hard'
      ? 'agency_hard_throttled'
      : score.action === 'soft'
      ? 'agency_soft_throttled'
      : 'agency_capacity_ok',
  };

  // Fire-and-forget audit log (non-blocking)
  // The resolver must not wait on this
  // from_agent must be a registered agent_registry identity (FK);
  // 'system:orchestrator' was unregistered, which silently killed every
  // audit write until P1375.
  return query(
    `INSERT INTO roadmap.message_ledger (
      from_agent, channel, message_type, metadata, project_id
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      'orchestrator',
      'system:capacity-throttle',
      'throttle_decision',
      JSON.stringify(metadata),
      projectId || 1, // Default to control-plane project if not specified
    ]
  ).then(() => undefined)
  .catch((err) => {
    console.warn('[P1365] Failed to log throttle decision:', err);
  });
}

/**
 * Multi-agency capacity check for resolver integration
 * Filters candidates by capacity, returns list with score multipliers
 *
 * TODO: Integrate into agency-resolver.ts ranking query
 * See AC-4/AC-8 for expected call site and JOIN pattern
 */
export async function filterByCapacity(
  candidates: Array<{ agencyId: string; provider: string; model: string }>,
  provider: string,
  model: string
): Promise<Array<{ agencyId: string; multiplier: number; score: CapacityScore }>> {
  const results = [];

  // Sequential awaits per [[feedback_concurrent_git_add]]: DB pool has known issues with parallel queries
  for (const candidate of candidates) {
    const { multiplier, score } = await computeCapacityScoreMultiplier(
      candidate.agencyId,
      provider,
      model
    );

    // Skip hard-throttled candidates (multiplier = 0)
    if (multiplier === 0) {
      continue;
    }

    results.push({
      agencyId: candidate.agencyId,
      multiplier,
      score,
    });
  }

  return results;
}

/**
 * P1365-AC4/AC8: Check if an agency is hard-throttled for a given provider/model.
 * Returns { isHardThrottled, score } for use in spawn path decision-making.
 * Emits audit log entry when soft/hard actions are applied.
 * P1365-AC9: Also applies soft-throttle cooldown to model_routes for P1359 coexistence.
 *
 * Integration point: agent-spawner.ts post-route-resolution, pre-spawn.
 */
export async function checkAgencyCapacity(
  agencyIdentity: string | null | undefined,
  provider: string,
  model: string,
  projectId: number | undefined
): Promise<{ isHardThrottled: boolean; score: CapacityScore }> {
  if (!agencyIdentity) {
    return {
      isHardThrottled: false,
      score: {
        action: 'none',
        p_skip: 0,
        headroom_pct: null,
        reset_at: null,
      },
    };
  }

  try {
    const { multiplier, score } = await computeCapacityScoreMultiplier(
      agencyIdentity,
      provider,
      model
    );

    const isHardThrottled = multiplier === 0;

    // Emit audit log for non-none actions (soft or hard throttle)
    if (score.action !== 'none') {
      await logThrottleDecision(
        agencyIdentity,
        provider,
        model,
        score,
        projectId ? String(projectId) : null
      );
    }

    // P1365-AC9: Apply soft-throttle cooldown to model_routes for P1359 coexistence
    // Soft-throttled agencies should cause the route to be deprioritized
    if (score.action === 'soft') {
      const { setSoftThrottleCooldown } = await import('./provider-cooldown.ts');
      await setSoftThrottleCooldown(provider, model, score.headroom_pct);
    }

    return { isHardThrottled, score };
  } catch (err) {
    console.error(
      `[P1365] Failed to check capacity for agency ${agencyIdentity} on ${provider}/${model}:`,
      err
    );
    // Fail open: assume healthy if capacity check fails
    return {
      isHardThrottled: false,
      score: {
        action: 'unknown',
        p_skip: 0,
        headroom_pct: null,
        reset_at: null,
      },
    };
  }
}
