/**
 * P465: Subscription-aware claim policy.
 *
 * Enforces per-agency quota windows (5h / daily / weekly / monthly) before
 * the liaison accepts a new work offer. If any window is projected to fall
 * below the safety_margin after the estimated claim cost, the claim is
 * refused and the agency self-declares throttled until the tightest window
 * resets.
 *
 * Three-layer usage fallback:
 *   1. provider_api  — live query to provider usage endpoint (when available)
 *   2. local_meter   — roadmap.agency_usage_meter accumulated by this service
 *   3. manual        — operator-entered values (overrides meter for that window)
 */

import { query } from "../postgres/pool.ts";

// ── Public interfaces (match proposal design exactly) ────────────────────────

export interface SubscriptionWindow {
  window_kind: "5h" | "daily" | "weekly" | "monthly" | "custom";
  resets_at: Date;
  quota_tokens?: number;
  quota_requests?: number;
  used_tokens: number;
  used_requests: number;
  source: "provider_api" | "local_meter" | "manual";
}

export interface CapacityEnvelope {
  agency_id: string;
  windows: SubscriptionWindow[];
  free_claim_slots: number;
  in_flight_claims: number;
  last_updated_at: Date;
}

export interface ClaimCostEstimate {
  tokens: number;
  requests: number;
}

export interface CapacityCheckResult {
  allowed: boolean;
  /** Set when refused: 'throttle:<window_kind>' */
  refuse_reason?: string;
  /** Timestamp when the tightest window resets (safe to re-check after this). */
  throttle_until?: Date;
}

// Internal config shape stored in agency_capacity_config.windows jsonb
interface WindowConfig {
  window_kind: "5h" | "daily" | "weekly" | "monthly" | "custom";
  quota_tokens?: number;
  quota_requests?: number;
  timezone?: string;
}

interface CapacityConfig {
  windows: WindowConfig[];
  safety_margin: number;
  refuse_below_slots: number;
  default_cost_estimate_tokens: number;
}

// Default cost estimate when the caller doesn't supply one.
// 50k tokens is a rough mid-range task budget; 1 request always.
const DEFAULT_COST_ESTIMATE: ClaimCostEstimate = { tokens: 50_000, requests: 1 };

// ── Window boundary helpers ───────────────────────────────────────────────────

/**
 * Compute the start of the current window (UTC-aligned).
 * e.g. for '5h' at 14:30 → 10:00 today.
 */
export function computeWindowStart(
  windowKind: WindowConfig["window_kind"],
  now: Date = new Date(),
): Date {
  const d = new Date(now);
  switch (windowKind) {
    case "5h": {
      const boundary = Math.floor(d.getUTCHours() / 5) * 5;
      d.setUTCHours(boundary, 0, 0, 0);
      return d;
    }
    case "daily": {
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "weekly": {
      // ISO week starts Monday; we use Sunday=0 convention for simplicity
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "monthly": {
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    default: {
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

/**
 * Compute when the current window expires (next boundary after `now`).
 * e.g. for 'daily' at 14:30 → midnight tonight.
 */
export function computeWindowResetAt(
  windowKind: WindowConfig["window_kind"],
  now: Date = new Date(),
): Date {
  const d = new Date(now);
  switch (windowKind) {
    case "5h": {
      const nextBoundaryH = (Math.floor(d.getUTCHours() / 5) + 1) * 5;
      if (nextBoundaryH >= 24) {
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(0, 0, 0, 0);
      } else {
        d.setUTCHours(nextBoundaryH, 0, 0, 0);
      }
      return d;
    }
    case "daily": {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "weekly": {
      const daysUntilNextSunday = 7 - d.getUTCDay();
      d.setUTCDate(d.getUTCDate() + daysUntilNextSunday);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "monthly": {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    default: {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Three-tier config resolution (AC-8):
 *   1. Per-agency row in agency_capacity_config
 *   2. Provider-level defaults from provider_capacity_defaults (via agency.provider)
 *   3. Built-in defaults (safety_margin=0.15, refuse_below_slots=1, no windows)
 */
async function loadCapacityConfig(agencyId: string): Promise<CapacityConfig | null> {
  // Tier 1: per-agency config
  const { rows } = await query<{
    windows: unknown;
    safety_margin: string;
    refuse_below_slots: number;
    default_cost_estimate_tokens: string;
  }>(
    `SELECT windows, safety_margin, refuse_below_slots, default_cost_estimate_tokens
       FROM roadmap.agency_capacity_config
      WHERE agency_id = $1`,
    [agencyId],
  );
  if (rows.length > 0) {
    const row = rows[0];
    const rawWindows = Array.isArray(row.windows) ? (row.windows as WindowConfig[]) : [];
    return {
      windows: rawWindows,
      safety_margin: parseFloat(row.safety_margin),
      refuse_below_slots: row.refuse_below_slots,
      default_cost_estimate_tokens: Number(row.default_cost_estimate_tokens ?? 50_000),
    };
  }

  // Tier 2: provider-level defaults
  const { rows: provRows } = await query<{
    windows: unknown;
    safety_margin: string;
    refuse_below_slots: number;
    default_cost_estimate_tokens: string;
  }>(
    `SELECT pcd.windows, pcd.safety_margin, pcd.refuse_below_slots, pcd.default_cost_estimate_tokens
       FROM roadmap.provider_capacity_defaults pcd
       JOIN roadmap.agency a ON a.provider = pcd.provider
      WHERE a.agency_id = $1`,
    [agencyId],
  );
  if (provRows.length > 0) {
    const row = provRows[0];
    const rawWindows = Array.isArray(row.windows) ? (row.windows as WindowConfig[]) : [];
    return {
      windows: rawWindows,
      safety_margin: parseFloat(row.safety_margin),
      refuse_below_slots: row.refuse_below_slots,
      default_cost_estimate_tokens: Number(row.default_cost_estimate_tokens ?? 50_000),
    };
  }

  // Tier 3: no config registered — caller treats null as unconstrained
  return null;
}

async function loadWindowUsage(
  agencyId: string,
  windowKind: string,
  windowStart: Date,
): Promise<{ used_tokens: number; used_requests: number; source: string }> {
  const { rows } = await query<{
    used_tokens: string;
    used_requests: string;
    source: string;
  }>(
    `SELECT used_tokens, used_requests, source
       FROM roadmap.agency_usage_meter
      WHERE agency_id = $1 AND window_kind = $2 AND window_start = $3`,
    [agencyId, windowKind, windowStart.toISOString()],
  );
  if (rows.length === 0) {
    return { used_tokens: 0, used_requests: 0, source: "local_meter" };
  }
  return {
    used_tokens: Number(rows[0].used_tokens),
    used_requests: Number(rows[0].used_requests),
    source: rows[0].source,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the full CapacityEnvelope for an agency.
 * Returns null when no config is registered (unconstrained).
 */
export async function getCapacityEnvelope(
  agencyId: string,
): Promise<CapacityEnvelope | null> {
  const config = await loadCapacityConfig(agencyId);
  if (!config) return null;

  const now = new Date();
  const windows: SubscriptionWindow[] = [];

  for (const wc of config.windows) {
    const windowStart = computeWindowStart(wc.window_kind, now);
    const resets_at = computeWindowResetAt(wc.window_kind, now);
    const usage = await loadWindowUsage(agencyId, wc.window_kind, windowStart);

    windows.push({
      window_kind: wc.window_kind,
      resets_at,
      quota_tokens: wc.quota_tokens,
      quota_requests: wc.quota_requests,
      used_tokens: usage.used_tokens,
      used_requests: usage.used_requests,
      source: usage.source as SubscriptionWindow["source"],
    });
  }

  const { rows: inFlightRows } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
       FROM roadmap_workforce.squad_dispatch
      WHERE agent_identity = $1
        AND offer_status = 'claimed'
        AND completed_at IS NULL`,
    [agencyId],
  );
  const in_flight_claims = Number(inFlightRows[0]?.cnt ?? 0);

  return {
    agency_id: agencyId,
    windows,
    free_claim_slots: Math.max(0, config.refuse_below_slots - in_flight_claims),
    in_flight_claims,
    last_updated_at: now,
  };
}

/**
 * Check whether the agency has quota capacity to absorb a new claim.
 *
 * Iterates all configured windows; if any window's projected remaining
 * fraction after spending `cost` falls below `safety_margin`, the check
 * fails and returns the tightest (soonest-resetting) window as the basis
 * for `throttle_until`.
 *
 * Returns `{ allowed: true }` when no config exists (unconstrained).
 */
export async function checkCapacityBeforeClaim(
  agencyId: string,
  cost?: ClaimCostEstimate,
): Promise<CapacityCheckResult> {
  const config = await loadCapacityConfig(agencyId);
  if (!config || config.windows.length === 0) {
    return { allowed: true };
  }
  const effectiveCost: ClaimCostEstimate = cost ?? {
    tokens: config.default_cost_estimate_tokens,
    requests: 1,
  };

  const now = new Date();
  // Track the window that is tightest (soonest to reset) that triggered refusal
  let tightest: { window_kind: string; resets_at: Date } | null = null;

  for (const wc of config.windows) {
    const windowStart = computeWindowStart(wc.window_kind, now);
    const resets_at = computeWindowResetAt(wc.window_kind, now);
    const usage = await loadWindowUsage(agencyId, wc.window_kind, windowStart);

    // Token quota check
    if (wc.quota_tokens != null && wc.quota_tokens > 0) {
      const remaining = wc.quota_tokens - usage.used_tokens;
      const projected = remaining - effectiveCost.tokens;
      const margin = projected / wc.quota_tokens;
      if (margin < config.safety_margin) {
        if (!tightest || resets_at < tightest.resets_at) {
          tightest = { window_kind: wc.window_kind, resets_at };
        }
      }
    }

    // Request quota check
    if (wc.quota_requests != null && wc.quota_requests > 0) {
      const remaining = wc.quota_requests - usage.used_requests;
      const projected = remaining - effectiveCost.requests;
      const margin = projected / wc.quota_requests;
      if (margin < config.safety_margin) {
        if (!tightest || resets_at < tightest.resets_at) {
          tightest = { window_kind: wc.window_kind, resets_at };
        }
      }
    }
  }

  if (tightest) {
    return {
      allowed: false,
      refuse_reason: `throttle:${tightest.window_kind}`,
      throttle_until: tightest.resets_at,
    };
  }

  return { allowed: true };
}

/**
 * Mark the agency throttled in the DB, storing the next-eligible timestamp.
 * Orchestrator reads `agency.status = 'throttled'` via dispatchable check.
 */
export async function declareAgencyThrottled(
  agencyId: string,
  until: Date,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE roadmap.agency
        SET status         = 'throttled',
            status_reason  = $2,
            throttled_until = $3
      WHERE agency_id = $1`,
    [agencyId, reason, until.toISOString()],
  );
}

/**
 * Restore the agency to active once the throttle window has passed.
 * No-op when the agency is not currently throttled.
 */
export async function clearThrottleIfExpired(agencyId: string): Promise<boolean> {
  const result = await query(
    `UPDATE roadmap.agency
        SET status          = 'active',
            status_reason   = 'Quota window reset',
            throttled_until = NULL
      WHERE agency_id = $1
        AND status = 'throttled'
        AND throttled_until IS NOT NULL
        AND throttled_until <= now()
      RETURNING agency_id`,
    [agencyId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record usage in the local meter (all applicable windows for this agency).
 * Upserts to ensure idempotent accumulation within the same window boundary.
 */
export async function recordUsage(
  agencyId: string,
  tokensUsed: number,
  requestsUsed: number = 1,
): Promise<void> {
  const config = await loadCapacityConfig(agencyId);
  if (!config || config.windows.length === 0) return;

  const now = new Date();
  for (const wc of config.windows) {
    const windowStart = computeWindowStart(wc.window_kind, now);
    await query(
      `INSERT INTO roadmap.agency_usage_meter
              (agency_id, window_kind, window_start, used_tokens, used_requests, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'local_meter', now())
       ON CONFLICT (agency_id, window_kind, window_start)
       DO UPDATE SET
         used_tokens   = roadmap.agency_usage_meter.used_tokens   + EXCLUDED.used_tokens,
         used_requests = roadmap.agency_usage_meter.used_requests + EXCLUDED.used_requests,
         updated_at    = now()`,
      [agencyId, wc.window_kind, windowStart.toISOString(), tokensUsed, requestsUsed],
    );
  }
}

/**
 * Record that a hard provider limit (429) was hit (AC-6).
 * Sets paused_at_provider_limit=true and provider_limit_paused_at on the dispatch row,
 * and writes a claim_paused message to message_ledger for the orchestrator.
 */
export async function recordProviderHardLimit(
  agencyId: string,
  dispatchId: number,
  resumeEligibleAt: Date,
): Promise<void> {
  await query(
    `UPDATE roadmap_workforce.squad_dispatch
        SET paused_at_provider_limit = true,
            provider_limit_paused_at = now(),
            metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('resume_eligible_at', $3::text)
      WHERE id = $1 AND agent_identity = $2`,
    [dispatchId, agencyId, resumeEligibleAt.toISOString()],
  );

  // Best-effort notification to orchestrator channel
  try {
    await query(
      `INSERT INTO roadmap.message_ledger
              (from_agent, channel, message_content, message_type, metadata)
       VALUES ($1, 'system:operator', $2, 'alert', $3)`,
      [
        agencyId,
        `Claim paused at provider hard limit for dispatch ${dispatchId}`,
        JSON.stringify({
          kind: "claim_paused",
          dispatch_id: dispatchId,
          agency_id: agencyId,
          reason: "provider_hard_limit",
          resume_eligible_at: resumeEligibleAt.toISOString(),
        }),
      ],
    );
  } catch {
    /* best-effort */
  }
}
