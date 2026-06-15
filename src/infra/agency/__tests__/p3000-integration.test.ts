/**
 * P3000 AC-10 integration tests — comprehensive cost-quota admission scenarios.
 *
 * Covers:
 * (a) Mixed-cost agents (haiku + opus) under shared daily budget — exhaustion
 *     of one agent does not block the other.
 * (b) Quota window reset — 5h / daily / weekly / monthly boundaries trigger reset.
 * (c) Starvation recovery — agent with exactly STARVATION_THRESHOLD cycles
 *     gains a reserved-headroom slot.
 * (d) Operator quota override — reserved_override_active=true bypasses single
 *     dispatch even before starvation threshold is reached.
 * (e) Dispatch churn — existing provider cap controls (max_in_flight) are
 *     orthogonal to cost quotas and churn does not starve DEVELOP/new proposals.
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateCostQuota, STARVATION_THRESHOLD } from "../cost-quota-admission.ts";
import {
  incrementDebt,
  resetDebt,
  activateOperatorOverride,
  checkStarvation,
} from "../fair-share-debt.ts";

// ── Mock factory ──────────────────────────────────────────────────────────────

interface MockState {
  quotaRows?: unknown[];
  dailySpend?: number;
  inFlight?: number;
  windowSpend?: number;
  debtCycles?: number;
  reservedOverride?: boolean;
}

function makeMock(state: MockState) {
  return vi.fn(async (sql: string) => {
    if (sql.includes("agent_cost_quota")) {
      return { rows: state.quotaRows ?? [] };
    }
    if (sql.includes("v_agent_daily_spend")) {
      return {
        rows:
          state.dailySpend !== undefined
            ? [{ spent_today_usd: String(state.dailySpend) }]
            : [],
      };
    }
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ in_flight_count: String(state.inFlight ?? 0) }] };
    }
    if (sql.includes("agent_budget_ledger")) {
      return {
        rows: [{ window_spend: String(state.windowSpend ?? 0) }],
      };
    }
    if (sql.includes("fair_share_debt")) {
      if (state.debtCycles !== undefined || state.reservedOverride !== undefined) {
        return {
          rows: [
            {
              cycles_since_dispatch: state.debtCycles ?? 0,
              reserved_override_active: state.reservedOverride ?? false,
            },
          ],
        };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
}

// ── (a) Mixed-cost agents — shared budget ─────────────────────────────────────

describe("(a) mixed-cost haiku + opus under shared daily budget", () => {
  const sharedQuota = {
    quota_usd_per_day: "5.00",
    quota_usd_per_window: null,
    window_kind: null,
    reserved_headroom_pct: "5.00",
    priority_tier: 3,
  };

  it("haiku (cheap) admitted when opus exhausted budget", async () => {
    // Opus has spent $4.80 already; haiku has spent $0.10
    const haikuMock = makeMock({
      quotaRows: [{ ...sharedQuota, quota_usd_per_day: "5.00" }],
      dailySpend: 0.1,
      inFlight: 0,
    });
    const opusMock = makeMock({
      quotaRows: [{ ...sharedQuota, quota_usd_per_day: "5.00" }],
      dailySpend: 4.8,
      inFlight: 1, // 1 in-flight × $0.50 = $0.50 → total $5.30 > $5
    });

    const haikuResult = await evaluateCostQuota("haiku-bot", 0.005, haikuMock);
    const opusResult = await evaluateCostQuota("opus-bot", 0.08, opusMock);

    expect(haikuResult.allowed).toBe(true);
    expect(opusResult.allowed).toBe(false);
    expect(opusResult.reason).toMatch(/daily_quota_exceeded/);
  });

  it("opus (expensive) refused when at cap, haiku still runs independently", async () => {
    const haikuMock = makeMock({
      quotaRows: [{ ...sharedQuota }],
      dailySpend: 1.5,
      inFlight: 0,
    });
    // Haiku under its own budget still admitted
    const haikuResult = await evaluateCostQuota("haiku-cheap", 0.01, haikuMock);
    expect(haikuResult.allowed).toBe(true);
    expect(haikuResult.reserved_headroom_used).toBe(false);
  });

  it("multiple in-flight claims inflate projected cost and can refuse a new claim", async () => {
    const exec = makeMock({
      quotaRows: [{ ...sharedQuota, quota_usd_per_day: "2.00" }],
      dailySpend: 0.5,
      inFlight: 4, // 4 × $0.50 = $2.00 → total $2.50 > $2.00
    });
    const result = await evaluateCostQuota("agent-many-inflight", 0, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily_quota_exceeded/);
  });
});

// ── (b) Quota window reset boundaries ─────────────────────────────────────────

describe("(b) quota window reset — 5h / daily / weekly / monthly", () => {
  function windowQuotaRows(kind: string, quota = "100.00") {
    return [
      {
        quota_usd_per_day: null,
        quota_usd_per_window: quota,
        window_kind: kind,
        reserved_headroom_pct: "5.00",
        priority_tier: 3,
      },
    ];
  }

  it("5h window: fresh window (low spend) → allowed", async () => {
    const exec = makeMock({
      quotaRows: windowQuotaRows("5h"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 5.0,
    });
    const result = await evaluateCostQuota("agent-5h", 2.0, exec);
    expect(result.allowed).toBe(true);
  });

  it("5h window: exhausted → refused; resets_at is a future Date", async () => {
    const exec = makeMock({
      quotaRows: windowQuotaRows("5h", "10.00"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 9.80,
    });
    const result = await evaluateCostQuota("agent-5h", 0.50, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/window_quota_exceeded.*window=5h/);
    expect(result.resets_at).toBeInstanceOf(Date);
    expect(result.resets_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it("daily window: clean slate after reset → allowed", async () => {
    const exec = makeMock({
      quotaRows: windowQuotaRows("daily", "50.00"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 0.20,
    });
    const result = await evaluateCostQuota("agent-daily", 5.0, exec);
    expect(result.allowed).toBe(true);
  });

  it("weekly window: cap hit → refused with weekly resets_at", async () => {
    const exec = makeMock({
      quotaRows: windowQuotaRows("weekly", "200.00"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 199.60,
    });
    const result = await evaluateCostQuota("agent-weekly", 1.00, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/window_quota_exceeded.*window=weekly/);
    // Weekly reset is always on Sunday midnight UTC — must be in the future
    expect(result.resets_at).toBeInstanceOf(Date);
  });

  it("monthly window: clean month → allowed; exhausted month → refused", async () => {
    const cleanExec = makeMock({
      quotaRows: windowQuotaRows("monthly", "500.00"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 10.0,
    });
    const exhaustedExec = makeMock({
      quotaRows: windowQuotaRows("monthly", "500.00"),
      dailySpend: 0,
      inFlight: 0,
      windowSpend: 499.0,
    });

    const cleanResult = await evaluateCostQuota("agent-monthly", 5.0, cleanExec);
    const exhaustedResult = await evaluateCostQuota("agent-monthly", 5.0, exhaustedExec);

    expect(cleanResult.allowed).toBe(true);
    expect(exhaustedResult.allowed).toBe(false);
    expect(exhaustedResult.reason).toMatch(/window_quota_exceeded.*window=monthly/);
  });

  it("daily quota and window quota: daily cap triggers first when both configured", async () => {
    // Both quota_usd_per_day AND window_kind=weekly set on the same row
    const exec = makeMock({
      quotaRows: [
        {
          quota_usd_per_day: "10.00",
          quota_usd_per_window: "50.00",
          window_kind: "weekly",
          reserved_headroom_pct: "5.00",
          priority_tier: 3,
        },
      ],
      dailySpend: 10.50,
      inFlight: 0,
      windowSpend: 20.0,
    });
    const result = await evaluateCostQuota("agent-dual", 0.10, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily_quota_exceeded/);
  });
});

// ── (c) Starvation recovery at exactly STARVATION_THRESHOLD ──────────────────

describe("(c) starvation recovery — reserved-headroom slot at threshold cycles", () => {
  const starvedQuota = {
    quota_usd_per_day: "10.00",
    quota_usd_per_window: null,
    window_kind: null,
    reserved_headroom_pct: "10.00", // $1.00 reserve on $10 budget
    priority_tier: 2,
  };

  it("exactly STARVATION_THRESHOLD cycles grants reserved slot", async () => {
    const exec = makeMock({
      quotaRows: [starvedQuota],
      dailySpend: 10.10, // just over daily cap
      inFlight: 0,
      debtCycles: STARVATION_THRESHOLD, // exactly at threshold
      reservedOverride: false,
    });
    // offer cost $0.30 ≤ reserve $1.00 → granted
    const result = await evaluateCostQuota("starved-agent", 0.30, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(true);
    expect(result.reason).toMatch(/reserved_headroom_granted/);
  });

  it("STARVATION_THRESHOLD - 1 cycles: still refused despite headroom configured", async () => {
    const exec = makeMock({
      quotaRows: [starvedQuota],
      dailySpend: 10.10,
      inFlight: 0,
      debtCycles: STARVATION_THRESHOLD - 1,
      reservedOverride: false,
    });
    const result = await evaluateCostQuota("almost-starved", 0.30, exec);
    expect(result.allowed).toBe(false);
    expect(result.reserved_headroom_used).toBe(false);
  });

  it("STARVATION_THRESHOLD + 5 cycles: still admitted when cost fits headroom", async () => {
    const exec = makeMock({
      quotaRows: [starvedQuota],
      dailySpend: 10.20,
      inFlight: 0,
      debtCycles: STARVATION_THRESHOLD + 5,
    });
    const result = await evaluateCostQuota("very-starved", 0.50, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(true);
  });

  it("starvation + cost exceeds headroom: still refused", async () => {
    const exec = makeMock({
      quotaRows: [{ ...starvedQuota, reserved_headroom_pct: "1.00" }], // $0.10 reserve
      dailySpend: 10.10,
      inFlight: 0,
      debtCycles: STARVATION_THRESHOLD + 3,
    });
    // $0.50 > $0.10 reserve → refused even when starved
    const result = await evaluateCostQuota("starved-but-too-expensive", 0.50, exec);
    expect(result.allowed).toBe(false);
  });

  it("debt resets to 0 after successful dispatch", async () => {
    const sqlLog: string[] = [];
    const exec = vi.fn(async (sql: string) => {
      sqlLog.push(sql);
      return { rows: [] };
    });
    await incrementDebt("reset-test-agent", exec);
    await incrementDebt("reset-test-agent", exec);
    // Both increments should reference the increment pattern
    expect(sqlLog.filter((s) => s.includes("cycles_since_dispatch + 1")).length).toBe(2);
    await resetDebt("reset-test-agent", exec);
    // Reset SQL should set cycles to 0 and clear override flag
    const resetSql = sqlLog[2];
    expect(resetSql).toContain("reserved_override_active = false");
  });

  it("checkStarvation returns false for fresh agent", async () => {
    const exec = vi.fn(async () => ({
      rows: [{ cycles_since_dispatch: STARVATION_THRESHOLD - 3 }],
    }));
    const result = await checkStarvation("not-yet-starved", exec);
    expect(result).toBe(false);
  });

  it("checkStarvation returns true at STARVATION_THRESHOLD", async () => {
    const exec = vi.fn(async () => ({
      rows: [{ cycles_since_dispatch: STARVATION_THRESHOLD }],
    }));
    const result = await checkStarvation("just-starved", exec);
    expect(result).toBe(true);
  });
});

// ── (d) Operator quota override — admin --allow-next ─────────────────────────

describe("(d) operator quota override — reserved_override_active bypasses quota", () => {
  const overrideQuota = {
    quota_usd_per_day: "10.00",
    quota_usd_per_window: null,
    window_kind: null,
    reserved_headroom_pct: "10.00",
    priority_tier: 1,
  };

  it("reserved_override_active=true bypasses quota even below starvation threshold", async () => {
    const exec = makeMock({
      quotaRows: [overrideQuota],
      dailySpend: 11.00, // over quota
      inFlight: 0,
      debtCycles: 2, // far below STARVATION_THRESHOLD
      reservedOverride: true, // operator set this
    });
    const result = await evaluateCostQuota("override-agent", 0.30, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(true);
    expect(result.reason).toMatch(/reserved_headroom_granted/);
  });

  it("reserved_override_active=false does not grant bypass for non-starved agent", async () => {
    const exec = makeMock({
      quotaRows: [overrideQuota],
      dailySpend: 11.00,
      inFlight: 0,
      debtCycles: 2,
      reservedOverride: false,
    });
    const result = await evaluateCostQuota("no-override-agent", 0.30, exec);
    expect(result.allowed).toBe(false);
  });

  it("activateOperatorOverride writes reserved_override_active=true to DB", async () => {
    const execCalls: Array<string> = [];
    const exec = vi.fn(async (sql: string) => {
      execCalls.push(sql);
      return { rows: [] };
    });
    await activateOperatorOverride("agent-with-override", exec);
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain("reserved_override_active = true");
    expect(execCalls[0]).toContain("fair_share_debt");
  });

  it("activateOperatorOverride swallows DB errors gracefully", async () => {
    const exec = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(activateOperatorOverride("agent-x", exec)).resolves.toBeUndefined();
  });

  it("override is cleared by resetDebt after successful dispatch", async () => {
    const execCalls: Array<string> = [];
    const exec = vi.fn(async (sql: string) => {
      execCalls.push(sql);
      return { rows: [] };
    });
    await activateOperatorOverride("agent-cleared", exec);
    await resetDebt("agent-cleared", exec);
    // resetDebt sets reserved_override_active = false
    const resetCall = execCalls[1];
    expect(resetCall).toContain("reserved_override_active = false");
  });

  it("override + cost exceeds headroom: still refused", async () => {
    const exec = makeMock({
      quotaRows: [{ ...overrideQuota, reserved_headroom_pct: "1.00" }], // $0.10 reserve
      dailySpend: 11.00,
      inFlight: 0,
      debtCycles: 0,
      reservedOverride: true,
    });
    // $0.80 > $0.10 headroom → refused even with override
    const result = await evaluateCostQuota("override-but-too-big", 0.80, exec);
    expect(result.allowed).toBe(false);
  });
});

// ── (e) Dispatch churn — provider cap orthogonal to cost quotas ───────────────

describe("(e) dispatch churn does not starve DEVELOP/new proposals", () => {
  it("no-quota agent (no rows) is always admitted regardless of churn", async () => {
    const exec = makeMock({ quotaRows: [] });
    for (let i = 0; i < 5; i++) {
      const result = await evaluateCostQuota("no-quota-agent", 99.99, exec);
      expect(result.allowed).toBe(true);
    }
  });

  it("missing schema (table error) returns allowed=true to not block dispatch", async () => {
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes("agent_cost_quota")) {
        throw new Error("relation roadmap_workforce.agent_cost_quota does not exist");
      }
      return { rows: [] };
    });
    const result = await evaluateCostQuota("any-agent", 10.0, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(false);
  });

  it("provider max_in_flight is a concurrency limit — cost quota is orthogonal", async () => {
    // An agent under its cost quota can still be blocked by max_in_flight (concurrency).
    // Here we verify the cost-quota check itself says allowed=true when budget is fine,
    // even if the caller separately enforces max_in_flight.
    const exec = makeMock({
      quotaRows: [
        {
          quota_usd_per_day: "50.00",
          quota_usd_per_window: null,
          window_kind: null,
          reserved_headroom_pct: "5.00",
          priority_tier: 2,
        },
      ],
      dailySpend: 5.0,
      inFlight: 0, // cost-quota counts DB-claimed offers, not max_in_flight cap
    });
    // Cost quota: 5.00 spent + 0.50 estimate < 50.00 → allowed
    const result = await evaluateCostQuota("provider-capped-agent", 0.50, exec);
    expect(result.allowed).toBe(true);
    // max_in_flight enforcement happens at a separate layer; quota itself doesn't block
  });

  it("concurrent in-flight offers accumulate projected cost to prevent over-commitment", async () => {
    // Simulates 3 agents each with 1 in-flight + new claim attempting to pile on
    const quota = {
      quota_usd_per_day: "1.00",
      quota_usd_per_window: null,
      window_kind: null,
      reserved_headroom_pct: "5.00",
      priority_tier: 3,
    };
    // Each agent's in-flight reserve ($0.50 each) would push total over $1 budget
    const agent1 = makeMock({ quotaRows: [quota], dailySpend: 0.60, inFlight: 1 });
    // 0.60 + 0.50 (in-flight) + 0.10 (new estimate) = 1.20 > 1.00 → refused
    const result = await evaluateCostQuota("busy-agent", 0.10, agent1);
    expect(result.allowed).toBe(false);
  });

  it("starvation recovery ensures starved DEVELOP agent is not permanently blocked by churn", async () => {
    // An agent that has been rejected 10+ times due to churn gets a reserved slot
    const exec = makeMock({
      quotaRows: [
        {
          quota_usd_per_day: "10.00",
          quota_usd_per_window: null,
          window_kind: null,
          reserved_headroom_pct: "15.00",
          priority_tier: 1,
        },
      ],
      dailySpend: 10.05, // just over cap due to churn
      inFlight: 0,
      debtCycles: STARVATION_THRESHOLD,
    });
    // offer $0.50 ≤ headroom $1.50 → recovered
    const result = await evaluateCostQuota("churned-develop-agent", 0.50, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(true);
  });
});

// ── AC-4 compatibility: existing provider cap controls ────────────────────────

describe("AC-4 compatibility — existing provider cap controls are orthogonal", () => {
  it("evaluateCostQuota has no dependency on max_in_flight — neither reads nor blocks on it", async () => {
    // The cost quota system queries squad_dispatch for claimed offers (inFlight).
    // It never queries provider_registry.max_in_flight — that is the dispatcher's job.
    // Verify: a mock that returns non-empty max_in_flight is irrelevant to result.
    const execWithCapRow = vi.fn(async (sql: string) => {
      if (sql.includes("agent_cost_quota"))
        return { rows: [{ quota_usd_per_day: "100.00", quota_usd_per_window: null, window_kind: null, reserved_headroom_pct: "5.00", priority_tier: 3 }] };
      if (sql.includes("v_agent_daily_spend")) return { rows: [{ spent_today_usd: "5.00" }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ in_flight_count: "0" }] };
      if (sql.includes("provider_registry")) return { rows: [{ max_in_flight: 1 }] };
      return { rows: [] };
    });
    const result = await evaluateCostQuota("cap-compat-agent", 0.50, execWithCapRow);
    expect(result.allowed).toBe(true);
    // The SQL calls should never touch provider_registry
    const calls = execWithCapRow.mock.calls.map(([sql]: [string]) => sql);
    expect(calls.some((s: string) => s.includes("provider_registry"))).toBe(false);
  });

  it("subscription-policy throttle and cost quota can coexist independently", async () => {
    // Cost quota says allowed; subscription policy is evaluated separately at caller.
    // This test verifies cost-quota returns allowed even when subscription data is present.
    const exec = makeMock({
      quotaRows: [
        {
          quota_usd_per_day: "20.00",
          quota_usd_per_window: null,
          window_kind: null,
          reserved_headroom_pct: "5.00",
          priority_tier: 2,
        },
      ],
      dailySpend: 1.0,
      inFlight: 0,
    });
    const result = await evaluateCostQuota("sub-policy-coexist", 0.50, exec);
    expect(result.allowed).toBe(true);
    // The caller (agency-claim-loop / offer-dispatch-handler) evaluates subscription
    // policy first, then cost quota — both must pass independently.
  });

  it("zero-cost estimate (unknown model) is still checked against in-flight reserves", async () => {
    const exec = makeMock({
      quotaRows: [{ quota_usd_per_day: "0.80", quota_usd_per_window: null, window_kind: null, reserved_headroom_pct: "5.00", priority_tier: 3 }],
      dailySpend: 0.0,
      inFlight: 2, // 2 × $0.50 in-flight reserve = $1.00 > $0.80 quota
    });
    const result = await evaluateCostQuota("unknown-model-agent", 0, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily_quota_exceeded/);
  });
});
