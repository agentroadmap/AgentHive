/**
 * P3000: Fair-share debt tracker.
 *
 * Tracks how many consecutive cycles an agent has been rejected (due to quota,
 * capacity, or any other reason). When cycles_since_dispatch exceeds
 * STARVATION_THRESHOLD, the cost-quota admission module grants a
 * reserved-headroom slot regardless of current spend.
 *
 * Debt lifecycle:
 *   incrementDebt()   — called on every dispatch REJECTION for this agent
 *   resetDebt()       — called on every successful dispatch for this agent
 *   checkStarvation() — returns true when cycles >= STARVATION_THRESHOLD
 *
 * Table: roadmap_workforce.fair_share_debt (already exists)
 *   agent_identity           text PK
 *   cycles_since_dispatch    int  (>= 0)
 *   last_claimed_at          timestamptz nullable
 *   reserved_override_active boolean
 *   updated_at               timestamptz
 */

import { query as defaultQuery } from "../postgres/pool.ts";
import { STARVATION_THRESHOLD } from "./cost-quota-admission.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Increment cycles_since_dispatch for an agent.
 * Upserts the row so the first rejection auto-creates it.
 */
export async function incrementDebt(
  agentIdentity: string,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO roadmap_workforce.fair_share_debt
              (agent_identity, cycles_since_dispatch, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (agent_identity) DO UPDATE
         SET cycles_since_dispatch = fair_share_debt.cycles_since_dispatch + 1,
             updated_at            = now()`,
      [agentIdentity],
    );
  } catch (err) {
    // Table may not exist during migration; never block dispatch path.
    console.warn("[FairShareDebt] incrementDebt failed:", (err as Error).message);
  }
}

/**
 * Reset cycles_since_dispatch to 0 and record last_claimed_at.
 * Called immediately after a successful fn_claim_work_offer.
 */
export async function resetDebt(
  agentIdentity: string,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO roadmap_workforce.fair_share_debt
              (agent_identity, cycles_since_dispatch, last_claimed_at,
               reserved_override_active, updated_at)
       VALUES ($1, 0, now(), false, now())
       ON CONFLICT (agent_identity) DO UPDATE
         SET cycles_since_dispatch    = 0,
             last_claimed_at          = now(),
             reserved_override_active = false,
             updated_at               = now()`,
      [agentIdentity],
    );
  } catch (err) {
    console.warn("[FairShareDebt] resetDebt failed:", (err as Error).message);
  }
}

/**
 * Returns true when the agent's debt exceeds the starvation threshold.
 */
export async function checkStarvation(
  agentIdentity: string,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<boolean> {
  try {
    const result = (await exec(
      `SELECT cycles_since_dispatch
         FROM roadmap_workforce.fair_share_debt
        WHERE agent_identity = $1`,
      [agentIdentity],
    )) as { rows: Array<{ cycles_since_dispatch: number }> } | undefined;
    const cycles = result?.rows?.[0]?.cycles_since_dispatch ?? 0;
    return cycles >= STARVATION_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Operator override: set reserved_override_active=true for an agent so the
 * next dispatch is admitted regardless of current spend (bypasses the daily cap
 * for a single offer). The flag is cleared by resetDebt() after successful dispatch.
 *
 * Used by: `hive quota override --agent <id> --allow-next` (admin CLI).
 * Audit log entry should be written by the caller before invoking this.
 */
export async function activateOperatorOverride(
  agentIdentity: string,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO roadmap_workforce.fair_share_debt
              (agent_identity, cycles_since_dispatch, reserved_override_active, updated_at)
       VALUES ($1, 0, true, now())
       ON CONFLICT (agent_identity) DO UPDATE
         SET reserved_override_active = true,
             updated_at               = now()`,
      [agentIdentity],
    );
  } catch (err) {
    console.warn("[FairShareDebt] activateOperatorOverride failed:", (err as Error).message);
  }
}

/**
 * Record that a reserved-headroom slot was granted (sets reserved_override_active=true
 * temporarily so the next dispatch can proceed even if debt is not yet reset).
 */
export async function markReservedOverrideActive(
  agentIdentity: string,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<void> {
  try {
    await exec(
      `INSERT INTO roadmap_workforce.fair_share_debt
              (agent_identity, cycles_since_dispatch, reserved_override_active, updated_at)
       VALUES ($1, 0, true, now())
       ON CONFLICT (agent_identity) DO UPDATE
         SET reserved_override_active = true,
             updated_at               = now()`,
      [agentIdentity],
    );
  } catch (err) {
    console.warn("[FairShareDebt] markReservedOverrideActive failed:", (err as Error).message);
  }
}
