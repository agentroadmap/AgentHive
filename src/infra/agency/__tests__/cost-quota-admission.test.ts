/**
 * P3000 integration tests — cost-quota admission control and starvation recovery.
 *
 * Uses an in-memory SQL executor (exec mock) instead of a real DB so the
 * tests are fast and portable. The mock is shaped to return data that exercises
 * all admission paths.
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateCostQuota, STARVATION_THRESHOLD } from "../cost-quota-admission.ts";
import { incrementDebt, resetDebt } from "../fair-share-debt.ts";

// ── SQL mock factory ──────────────────────────────────────────────────────────

type MockTable =
  | "agent_cost_quota"
  | "v_agent_daily_spend"
  | "squad_dispatch_count"
  | "fair_share_debt";

function makeMockExec(tables: Partial<Record<MockTable, unknown[]>>) {
  return vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes("agent_cost_quota")) {
      return { rows: tables.agent_cost_quota ?? [] };
    }
    if (sql.includes("v_agent_daily_spend")) {
      return { rows: tables.v_agent_daily_spend ?? [] };
    }
    if (sql.includes("COUNT(*)")) {
      return { rows: tables.squad_dispatch_count ?? [{ in_flight_count: "0" }] };
    }
    if (sql.includes("fair_share_debt")) {
      return { rows: tables.fair_share_debt ?? [] };
    }
    return { rows: [] };
  });
}

const baseQuotaRow = {
  quota_usd_per_day: "10.00",
  quota_usd_per_window: null,
  window_kind: null,
  reserved_headroom_pct: "5.00",
  priority_tier: 3,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateCostQuota — no quota configured", () => {
  it("returns allowed=true when table has no rows for this agent", async () => {
    const exec = makeMockExec({ agent_cost_quota: [] });
    const result = await evaluateCostQuota("agent-a", 0, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(false);
  });

  it("returns allowed=true when agent_cost_quota table does not exist yet", async () => {
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes("agent_cost_quota")) throw new Error("relation does not exist");
      return { rows: [] };
    });
    const result = await evaluateCostQuota("agent-a", 0, exec);
    expect(result.allowed).toBe(true);
  });
});

describe("evaluateCostQuota — daily quota enforcement", () => {
  it("allows when projected spend is under quota", async () => {
    const exec = makeMockExec({
      agent_cost_quota: [baseQuotaRow],
      v_agent_daily_spend: [{ spent_today_usd: "4.00" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
    });
    const result = await evaluateCostQuota("opus-agent", 0, exec);
    expect(result.allowed).toBe(true);
  });

  it("refuses when projected spend exceeds daily quota", async () => {
    const exec = makeMockExec({
      agent_cost_quota: [baseQuotaRow],
      v_agent_daily_spend: [{ spent_today_usd: "9.80" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
    });
    // 9.80 + 0 (estimated) = 9.80; quota=10, but with 1 in-flight @$0.5 = 10.30 > 10
    const result = await evaluateCostQuota("opus-agent", 0.60, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily_quota_exceeded/);
    expect(result.resets_at).toBeInstanceOf(Date);
  });

  it("mixed-cost agents: cheap agent under budget, expensive agent refused", async () => {
    const haiku = makeMockExec({
      agent_cost_quota: [{ ...baseQuotaRow, quota_usd_per_day: "2.00" }],
      v_agent_daily_spend: [{ spent_today_usd: "0.50" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
    });
    const opus = makeMockExec({
      agent_cost_quota: [{ ...baseQuotaRow, quota_usd_per_day: "2.00" }],
      v_agent_daily_spend: [{ spent_today_usd: "1.90" }],
      squad_dispatch_count: [{ in_flight_count: "1" }],
    });
    const haikuResult = await evaluateCostQuota("haiku-bot", 0.05, haiku);
    const opusResult = await evaluateCostQuota("opus-bot", 0.50, opus);

    expect(haikuResult.allowed).toBe(true);
    expect(opusResult.allowed).toBe(false);
  });
});

describe("evaluateCostQuota — starvation recovery (reserved headroom)", () => {
  it("grants reserved-headroom slot when agent exceeds threshold cycles", async () => {
    const exec = makeMockExec({
      agent_cost_quota: [{ ...baseQuotaRow, reserved_headroom_pct: "10.00" }],
      // spent 10.20 — over the $10 daily limit
      v_agent_daily_spend: [{ spent_today_usd: "10.20" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
      fair_share_debt: [
        {
          cycles_since_dispatch: STARVATION_THRESHOLD + 1,
          reserved_override_active: false,
        },
      ],
    });
    // estimated cost 0.20 → total projected = 10.40; reserved = 10*10% = 1.0 USD
    // new offer cost = 0.20 ≤ 1.0 → reserved slot granted
    const result = await evaluateCostQuota("starved-opus", 0.20, exec);
    expect(result.allowed).toBe(true);
    expect(result.reserved_headroom_used).toBe(true);
    expect(result.reason).toMatch(/reserved_headroom_granted/);
  });

  it("still refuses if starvation cost exceeds the reserved budget", async () => {
    const exec = makeMockExec({
      agent_cost_quota: [{ ...baseQuotaRow, reserved_headroom_pct: "1.00" }],
      v_agent_daily_spend: [{ spent_today_usd: "10.50" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
      fair_share_debt: [
        {
          cycles_since_dispatch: STARVATION_THRESHOLD + 5,
          reserved_override_active: false,
        },
      ],
    });
    // reserved = 10*1% = $0.10; offer cost $0.80 > $0.10 → refuse
    const result = await evaluateCostQuota("very-starved", 0.80, exec);
    expect(result.allowed).toBe(false);
  });

  it("not-yet-starved agent is refused even with headroom configured", async () => {
    const exec = makeMockExec({
      agent_cost_quota: [{ ...baseQuotaRow, reserved_headroom_pct: "20.00" }],
      v_agent_daily_spend: [{ spent_today_usd: "10.10" }],
      squad_dispatch_count: [{ in_flight_count: "0" }],
      fair_share_debt: [
        {
          cycles_since_dispatch: STARVATION_THRESHOLD - 2,
          reserved_override_active: false,
        },
      ],
    });
    const result = await evaluateCostQuota("normal-agent", 0.10, exec);
    expect(result.allowed).toBe(false);
  });
});

describe("evaluateCostQuota — quota window reset boundary", () => {
  it("allows when spend in prior week exists but current window is clean", async () => {
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes("agent_cost_quota")) {
        return {
          rows: [
            {
              quota_usd_per_day: null,
              quota_usd_per_window: "50.00",
              window_kind: "weekly",
              reserved_headroom_pct: "5.00",
              priority_tier: 3,
            },
          ],
        };
      }
      if (sql.includes("v_agent_daily_spend")) return { rows: [] };
      if (sql.includes("COUNT(*)")) return { rows: [{ in_flight_count: "0" }] };
      // Window spend query: return low spend (new window)
      if (sql.includes("agent_budget_ledger")) {
        return { rows: [{ window_spend: "1.50" }] };
      }
      if (sql.includes("fair_share_debt")) return { rows: [] };
      return { rows: [] };
    });
    const result = await evaluateCostQuota("weekly-budget-agent", 2.00, exec);
    expect(result.allowed).toBe(true);
  });

  it("refuses when weekly window spend is at cap", async () => {
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes("agent_cost_quota")) {
        return {
          rows: [
            {
              quota_usd_per_day: null,
              quota_usd_per_window: "50.00",
              window_kind: "weekly",
              reserved_headroom_pct: "5.00",
              priority_tier: 3,
            },
          ],
        };
      }
      if (sql.includes("v_agent_daily_spend")) return { rows: [] };
      if (sql.includes("COUNT(*)")) return { rows: [{ in_flight_count: "0" }] };
      if (sql.includes("agent_budget_ledger")) {
        return { rows: [{ window_spend: "49.80" }] };
      }
      if (sql.includes("fair_share_debt")) return { rows: [] };
      return { rows: [] };
    });
    const result = await evaluateCostQuota("weekly-budget-agent", 0.50, exec);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/window_quota_exceeded/);
    expect(result.resets_at).toBeInstanceOf(Date);
  });
});

describe("fair-share-debt helpers", () => {
  it("incrementDebt inserts/upserts without throwing", async () => {
    const exec = vi.fn(async () => ({ rows: [] }));
    await expect(incrementDebt("agent-x", exec)).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toContain("cycles_since_dispatch");
  });

  it("resetDebt sets cycles_since_dispatch to 0", async () => {
    const exec = vi.fn(async () => ({ rows: [] }));
    await expect(resetDebt("agent-x", exec)).resolves.toBeUndefined();
    expect(exec.mock.calls[0][0]).toContain("cycles_since_dispatch");
  });

  it("incrementDebt swallows DB errors", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(incrementDebt("agent-x", exec)).resolves.toBeUndefined();
  });

  it("resetDebt swallows DB errors", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(resetDebt("agent-x", exec)).resolves.toBeUndefined();
  });
});
