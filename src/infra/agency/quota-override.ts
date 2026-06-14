/**
 * P3000 AC-10d — operator quota dispatch override.
 *
 * An operator can grant a one-shot (single_use=true) or standing
 * (single_use=false) bypass of the subscription-policy quota check for a
 * specific agent identity.  Single-use rows are consumed atomically via
 * UPDATE…FOR UPDATE SKIP LOCKED so concurrent claim attempts cannot both
 * consume the same override.  All functions are fail-closed: any DB error
 * returns null, never granting an accidental bypass.
 */

import { defaultQuery } from "../../db/pool.ts";

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface OverrideRecord {
  id: number;
  agentIdentity: string;
  grantedBy: string;
  overrideReason: string | null;
  singleUse: boolean;
  expiresAt: Date;
  createdAt: Date;
}

let _defaultQuery: QueryFn | null = null;
async function getDefaultQuery(): Promise<QueryFn> {
  if (!_defaultQuery) {
    const mod = await import("../../db/pool.ts");
    _defaultQuery = mod.defaultQuery as unknown as QueryFn;
  }
  return _defaultQuery!;
}

function rowToRecord(row: Record<string, unknown>): OverrideRecord {
  return {
    id: Number(row.id),
    agentIdentity: row.agent_identity as string,
    grantedBy: row.granted_by as string,
    overrideReason: (row.override_reason as string | null) ?? null,
    singleUse: row.single_use as boolean,
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Atomically consume a single-use override and return its record, or return
 * null if none exists (or on DB error — fail-closed).
 */
export async function checkAndConsumeQuotaOverride(
  agentIdentity: string,
  q?: QueryFn,
): Promise<OverrideRecord | null> {
  try {
    const run = q ?? (await getDefaultQuery());
    const { rows } = await run(
      `UPDATE roadmap_workforce.quota_dispatch_override
          SET used_at = now()
        WHERE id = (
          SELECT id
            FROM roadmap_workforce.quota_dispatch_override
           WHERE agent_identity = $1
             AND used_at IS NULL
             AND expires_at > now()
             AND single_use = true
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING
         id,
         agent_identity,
         granted_by,
         override_reason,
         single_use,
         expires_at,
         created_at`,
      [agentIdentity],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  } catch (err) {
    console.error("[quota-override] checkAndConsumeQuotaOverride error (fail-closed):", err);
    return null;
  }
}

/**
 * Check for a standing (single_use=false) override without consuming it.
 */
export async function checkStandingOverride(
  agentIdentity: string,
  q?: QueryFn,
): Promise<OverrideRecord | null> {
  try {
    const run = q ?? (await getDefaultQuery());
    const { rows } = await run(
      `SELECT id, agent_identity, granted_by, override_reason, single_use, expires_at, created_at
         FROM roadmap_workforce.quota_dispatch_override
        WHERE agent_identity = $1
          AND used_at IS NULL
          AND expires_at > now()
          AND single_use = false
        ORDER BY created_at ASC
        LIMIT 1`,
      [agentIdentity],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  } catch (err) {
    console.error("[quota-override] checkStandingOverride error (fail-closed):", err);
    return null;
  }
}

/**
 * Returns the first active override for an agent, preferring single-use
 * (consumed if found) over standing.  Returns null if none exists or on error.
 */
export async function hasActiveOverride(
  agentIdentity: string,
  q?: QueryFn,
): Promise<OverrideRecord | null> {
  const single = await checkAndConsumeQuotaOverride(agentIdentity, q);
  if (single) return single;
  return checkStandingOverride(agentIdentity, q);
}
