/**
 * P3000: Per-agent cost quota admission control.
 *
 * Evaluated at two chokepoints before spawning:
 *   1. Claim time  (agency-claim-loop.ts::claimOne)
 *   2. Dispatch time (offer-dispatch-handler.ts::handleOfferDispatch)
 *
 * Decision: if agent's cumulative daily spend + in-flight estimates + this
 * offer's estimated cost exceeds quota_usd_per_day, the offer is refused.
 * The caller returns the offer via fn_return_work_offer so it re-enters
 * the pool for other agents.
 *
 * In-flight cost estimate: $0.50 per in-flight offer as a conservative
 * placeholder until P1018 wires richer per-model estimates. Prevents an
 * agent from claiming all open offers simultaneously before any complete.
 *
 * Starvation guard: if an agent has been starved for > STARVATION_THRESHOLD
 * cycles and has a reserved_headroom_pct > 0, one reserved-slot dispatch is
 * allowed regardless of the current spend. Cost is still recorded normally.
 */

import { query as defaultQuery } from "../postgres/pool.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface QuotaAdmissionResult {
  allowed: boolean;
  reason: string | null;
  /** When the quota window resets (for throttle declaration). */
  resets_at: Date | null;
  /** True when a reserved-headroom slot was consumed for starvation recovery. */
  reserved_headroom_used: boolean;
}

/** Default in-flight cost estimate per claimed offer (USD). */
const IN_FLIGHT_COST_ESTIMATE_USD = 0.5;

/** Cycles of rejection before starvation recovery kicks in. */
export const STARVATION_THRESHOLD = 10;

interface QuotaRow {
  quota_usd_per_day: string | null;
  quota_usd_per_window: string | null;
  window_kind: string | null;
  reserved_headroom_pct: string;
  priority_tier: number;
}

interface SpendRow {
  spent_today_usd: string | null;
  runs_today: string | null;
}

interface InFlightRow {
  in_flight_count: string;
}

interface DebtRow {
  cycles_since_dispatch: number;
  reserved_override_active: boolean;
}

/**
 * Evaluate whether a new claim for `agencyId` should be admitted based on
 * cost quota policy. Returns allowed=true when no quota is configured.
 *
 * @param agencyId         Agent identity to check
 * @param estimatedCostUsd Caller-supplied cost estimate for this offer (USD).
 *                         Pass 0 when unknown; the function adds the per-offer
 *                         in-flight reserve automatically.
 * @param exec             SQL executor (injected for tests)
 */
export async function evaluateCostQuota(
  agencyId: string,
  estimatedCostUsd = 0,
  exec: SqlExec = defaultQuery as SqlExec,
): Promise<QuotaAdmissionResult> {
  // Load quota policies for this agent.
  let quotaRows: QuotaRow[] = [];
  try {
    const result = (await exec(
      `SELECT quota_usd_per_day, quota_usd_per_window, window_kind,
              reserved_headroom_pct, priority_tier
         FROM roadmap_workforce.agent_cost_quota
        WHERE agent_identity = $1 AND is_active`,
      [agencyId],
    )) as { rows: QuotaRow[] } | undefined;
    quotaRows = result?.rows ?? [];
  } catch {
    // Schema not yet applied — no constraint, allow.
    return { allowed: true, reason: null, resets_at: null, reserved_headroom_used: false };
  }

  if (quotaRows.length === 0) {
    return { allowed: true, reason: null, resets_at: null, reserved_headroom_used: false };
  }

  // Gather today's cumulative spend.
  let spentTodayUsd = 0;
  try {
    const result = (await exec(
      `SELECT spent_today_usd FROM roadmap_workforce.v_agent_daily_spend
        WHERE agent_identity = $1`,
      [agencyId],
    )) as { rows: SpendRow[] } | undefined;
    spentTodayUsd = parseFloat(result?.rows?.[0]?.spent_today_usd ?? "0") || 0;
  } catch {
    // View may not exist yet; treat as zero spend.
  }

  // Count in-flight claims and add their estimated cost.
  let inFlightCount = 0;
  try {
    const result = (await exec(
      `SELECT COUNT(*) AS in_flight_count
         FROM roadmap_workforce.squad_dispatch
        WHERE agent_identity = $1
          AND offer_status = 'claimed'
          AND completed_at IS NULL`,
      [agencyId],
    )) as { rows: InFlightRow[] } | undefined;
    inFlightCount = parseInt(result?.rows?.[0]?.in_flight_count ?? "0", 10) || 0;
  } catch {
    /* best-effort */
  }

  const totalProjectedUsd =
    spentTodayUsd +
    inFlightCount * IN_FLIGHT_COST_ESTIMATE_USD +
    estimatedCostUsd;

  // Check starvation state; a reserved override bypasses the daily cap once.
  let debtRow: DebtRow | null = null;
  try {
    const result = (await exec(
      `SELECT cycles_since_dispatch, reserved_override_active
         FROM roadmap_workforce.fair_share_debt
        WHERE agent_identity = $1`,
      [agencyId],
    )) as { rows: DebtRow[] } | undefined;
    debtRow = result?.rows?.[0] ?? null;
  } catch {
    /* best-effort */
  }

  const isStarved = (debtRow?.cycles_since_dispatch ?? 0) >= STARVATION_THRESHOLD;
  const reservedOverrideActive = debtRow?.reserved_override_active ?? false;

  // Evaluate each quota dimension.
  for (const q of quotaRows) {
    const daily = q.quota_usd_per_day !== null ? parseFloat(q.quota_usd_per_day) : null;

    if (daily !== null && totalProjectedUsd > daily) {
      const reservedHeadroom = parseFloat(q.reserved_headroom_pct) / 100;
      const reservedBudget = daily * reservedHeadroom;
      const wouldFitInReserve = totalProjectedUsd - spentTodayUsd <= reservedBudget;

      if ((isStarved || reservedOverrideActive) && wouldFitInReserve) {
        // Grant reserved-headroom slot; caller emits quota:reserved_headroom_granted.
        return {
          allowed: true,
          reason: `reserved_headroom_granted:starved=${isStarved}`,
          resets_at: nextUtcMidnight(),
          reserved_headroom_used: true,
        };
      }

      return {
        allowed: false,
        reason: `daily_quota_exceeded:spent=${spentTodayUsd.toFixed(4)},projected=${totalProjectedUsd.toFixed(4)},quota=${daily}`,
        resets_at: nextUtcMidnight(),
        reserved_headroom_used: false,
      };
    }

    // Per-window quota check (non-daily windows).
    if (q.quota_usd_per_window !== null && q.window_kind && q.window_kind !== "daily") {
      const windowQuota = parseFloat(q.quota_usd_per_window);
      const windowStart = computeWindowStart(q.window_kind as WindowKind);
      let windowSpend = 0;
      try {
        const result = (await exec(
          `SELECT COALESCE(SUM(cost_usd), 0) AS window_spend
             FROM roadmap_efficiency.agent_budget_ledger
            WHERE agent_identity = $1 AND recorded_at >= $2`,
          [agencyId, windowStart.toISOString()],
        )) as { rows: Array<{ window_spend: string }> } | undefined;
        windowSpend = parseFloat(result?.rows?.[0]?.window_spend ?? "0") || 0;
      } catch {
        /* best-effort */
      }

      const windowProjected =
        windowSpend + inFlightCount * IN_FLIGHT_COST_ESTIMATE_USD + estimatedCostUsd;

      if (windowProjected > windowQuota) {
        const resets_at = computeWindowResetAt(q.window_kind as WindowKind);
        return {
          allowed: false,
          reason: `window_quota_exceeded:window=${q.window_kind},spent=${windowSpend.toFixed(4)},projected=${windowProjected.toFixed(4)},quota=${windowQuota}`,
          resets_at,
          reserved_headroom_used: false,
        };
      }
    }
  }

  return { allowed: true, reason: null, resets_at: null, reserved_headroom_used: false };
}

// ── Window helpers (mirrors subscription-policy.ts) ──────────────────────────

type WindowKind = "5h" | "daily" | "weekly" | "monthly";

function computeWindowStart(kind: WindowKind, now = new Date()): Date {
  const d = new Date(now);
  switch (kind) {
    case "5h": {
      const h = Math.floor(d.getUTCHours() / 5) * 5;
      d.setUTCHours(h, 0, 0, 0);
      return d;
    }
    case "daily":
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "weekly":
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "monthly":
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

function computeWindowResetAt(kind: WindowKind, now = new Date()): Date {
  const d = new Date(now);
  switch (kind) {
    case "5h": {
      const nextH = (Math.floor(d.getUTCHours() / 5) + 1) * 5;
      if (nextH >= 24) {
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(0, 0, 0, 0);
      } else {
        d.setUTCHours(nextH, 0, 0, 0);
      }
      return d;
    }
    case "daily":
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "weekly":
      d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()));
      d.setUTCHours(0, 0, 0, 0);
      return d;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

function nextUtcMidnight(now = new Date()): Date {
  return computeWindowResetAt("daily", now);
}
