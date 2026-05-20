/**
 * P465: Unit tests for subscription-quota helpers.
 *
 * DB-dependent functions (loadCapacityConfig, loadWindowUsage) are mocked so
 * tests run without a live database. Window boundary math is pure and tested
 * without mocking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeWindowStart,
  computeWindowResetAt,
  checkCapacityBeforeClaim,
  getCapacityEnvelope,
  type ClaimCostEstimate,
} from "./subscription-quota.ts";

// ── Window boundary helpers ───────────────────────────────────────────────────

describe("computeWindowStart", () => {
  it("5h: floors to current 5-hour boundary", () => {
    const t = new Date("2025-01-01T14:30:00Z"); // 14h → boundary 10h
    const s = computeWindowStart("5h", t);
    expect(s.getUTCHours()).toBe(10);
    expect(s.getUTCMinutes()).toBe(0);
    expect(s.getUTCSeconds()).toBe(0);
  });

  it("5h: hour 0 → boundary 0", () => {
    const t = new Date("2025-01-01T02:45:00Z");
    expect(computeWindowStart("5h", t).getUTCHours()).toBe(0);
  });

  it("5h: hour 20 → boundary 20", () => {
    const t = new Date("2025-01-01T22:15:00Z");
    expect(computeWindowStart("5h", t).getUTCHours()).toBe(20);
  });

  it("daily: resets to midnight UTC", () => {
    const t = new Date("2025-06-15T17:45:00Z");
    const s = computeWindowStart("daily", t);
    expect(s.toISOString()).toBe("2025-06-15T00:00:00.000Z");
  });

  it("monthly: resets to 1st of month", () => {
    const t = new Date("2025-06-20T12:00:00Z");
    const s = computeWindowStart("monthly", t);
    expect(s.toISOString()).toBe("2025-06-01T00:00:00.000Z");
  });

  it("weekly: resets to Sunday (UTC)", () => {
    // 2025-06-18 is a Wednesday (day=3); Sunday before = 2025-06-15
    const t = new Date("2025-06-18T12:00:00Z");
    const s = computeWindowStart("weekly", t);
    expect(s.toISOString()).toBe("2025-06-15T00:00:00.000Z");
  });
});

describe("computeWindowResetAt", () => {
  it("5h: next 5-hour boundary", () => {
    const t = new Date("2025-01-01T14:30:00Z"); // in [10,15) → resets at 15h
    const r = computeWindowResetAt("5h", t);
    expect(r.getUTCHours()).toBe(15);
    expect(r.getUTCMinutes()).toBe(0);
  });

  it("5h: last window of day wraps to midnight next day", () => {
    const t = new Date("2025-01-01T22:00:00Z"); // [20,25) → next day 00:00
    const r = computeWindowResetAt("5h", t);
    expect(r.toISOString()).toBe("2025-01-02T00:00:00.000Z");
  });

  it("daily: midnight of next day", () => {
    const t = new Date("2025-06-15T17:45:00Z");
    expect(computeWindowResetAt("daily", t).toISOString()).toBe(
      "2025-06-16T00:00:00.000Z",
    );
  });

  it("monthly: 1st of next month", () => {
    const t = new Date("2025-06-20T12:00:00Z");
    expect(computeWindowResetAt("monthly", t).toISOString()).toBe(
      "2025-07-01T00:00:00.000Z",
    );
  });

  it("weekly: next Sunday", () => {
    // 2025-06-18 Wednesday → next Sunday 2025-06-22
    const t = new Date("2025-06-18T12:00:00Z");
    expect(computeWindowResetAt("weekly", t).toISOString()).toBe(
      "2025-06-22T00:00:00.000Z",
    );
  });
});

// ── checkCapacityBeforeClaim ──────────────────────────────────────────────────

vi.mock("../postgres/pool.ts", () => ({
  query: vi.fn(),
}));

import { query } from "../postgres/pool.ts";

const mockQuery = query as ReturnType<typeof vi.fn>;

const BASE_CONFIG_ROW = {
  windows: [{ window_kind: "daily", quota_tokens: 1_000_000, quota_requests: 100 }],
  safety_margin: "0.15",
  refuse_below_slots: 1,
};

function mockConfigAndUsage(
  config: typeof BASE_CONFIG_ROW,
  usageRows: Array<{ used_tokens: string; used_requests: string; source: string }>,
  inFlightCount = 0,
) {
  mockQuery
    .mockResolvedValueOnce({ rows: [config] })          // loadCapacityConfig
    .mockResolvedValueOnce({ rows: usageRows })          // loadWindowUsage
    .mockResolvedValueOnce({ rows: [{ cnt: String(inFlightCount) }] }); // in_flight count (for getCapacityEnvelope path)
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("checkCapacityBeforeClaim", () => {
  it("allows when no config exists (unconstrained)", async () => {
    // Two queries: tier-1 (agency_capacity_config) + tier-2 (provider_capacity_defaults)
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await checkCapacityBeforeClaim("agency-x");
    expect(result.allowed).toBe(true);
  });

  it("allows when projected margin >= safety_margin", async () => {
    // quota=1M, used=400k, cost=50k → remaining after = 550k, margin = 0.55 ≥ 0.15
    mockQuery
      .mockResolvedValueOnce({ rows: [BASE_CONFIG_ROW] })
      .mockResolvedValueOnce({
        rows: [{ used_tokens: "400000", used_requests: "5", source: "local_meter" }],
      });
    const result = await checkCapacityBeforeClaim("agency-x", { tokens: 50_000, requests: 1 });
    expect(result.allowed).toBe(true);
  });

  it("refuses when token margin < safety_margin", async () => {
    // quota=1M, used=900k, cost=200k → remaining after = -100k, margin < 0 < 0.15
    mockQuery
      .mockResolvedValueOnce({ rows: [BASE_CONFIG_ROW] })
      .mockResolvedValueOnce({
        rows: [{ used_tokens: "900000", used_requests: "5", source: "local_meter" }],
      });
    const result = await checkCapacityBeforeClaim("agency-x", { tokens: 200_000, requests: 1 });
    expect(result.allowed).toBe(false);
    expect(result.refuse_reason).toBe("throttle:daily");
    expect(result.throttle_until).toBeInstanceOf(Date);
  });

  it("refuses when request margin < safety_margin", async () => {
    // quota=100 requests, used=90, cost=15 → remaining after = -5, margin < 0 < 0.15
    mockQuery
      .mockResolvedValueOnce({ rows: [BASE_CONFIG_ROW] })
      .mockResolvedValueOnce({
        rows: [{ used_tokens: "100", used_requests: "90", source: "local_meter" }],
      });
    const result = await checkCapacityBeforeClaim("agency-x", { tokens: 1_000, requests: 15 });
    expect(result.allowed).toBe(false);
    expect(result.refuse_reason).toBe("throttle:daily");
  });

  it("uses tightest window when multiple windows fail", async () => {
    const multiWindowConfig = {
      windows: [
        { window_kind: "daily", quota_tokens: 1_000_000 },
        { window_kind: "monthly", quota_tokens: 10_000_000 },
      ],
      safety_margin: "0.15",
      refuse_below_slots: 1,
    };
    // Both exhausted; daily resets sooner
    mockQuery
      .mockResolvedValueOnce({ rows: [multiWindowConfig] })
      .mockResolvedValueOnce({
        rows: [{ used_tokens: "990000", used_requests: "0", source: "local_meter" }],
      })
      .mockResolvedValueOnce({
        rows: [{ used_tokens: "9990000", used_requests: "0", source: "local_meter" }],
      });

    const result = await checkCapacityBeforeClaim("agency-x", { tokens: 200_000, requests: 0 });
    expect(result.allowed).toBe(false);
    expect(result.refuse_reason).toBe("throttle:daily");
  });

  it("allows when usage returns empty rows (no meter data = 0 usage)", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [BASE_CONFIG_ROW] })
      .mockResolvedValueOnce({ rows: [] }); // no usage recorded yet
    const result = await checkCapacityBeforeClaim("agency-x", { tokens: 50_000, requests: 1 });
    expect(result.allowed).toBe(true);
  });
});
