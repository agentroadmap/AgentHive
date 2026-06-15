import { describe, it, expect } from "bun:test";
import {
  checkAndConsumeQuotaOverride,
  checkStandingOverride,
  hasActiveOverride,
  type OverrideRecord,
} from "./quota-override.ts";

// ---------------------------------------------------------------------------
// In-memory fake QueryFn helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;

function makeQuery(rows: Row[]): QueryFn {
  return async () => ({ rows });
}

function makeErrorQuery(msg = "DB connection refused"): QueryFn {
  return async () => {
    throw new Error(msg);
  };
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();
const NOW = new Date().toISOString();

function fakeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1n,
    agent_identity: "test-agent",
    granted_by: "operator",
    override_reason: "manual grant",
    single_use: true,
    expires_at: FUTURE,
    created_at: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkAndConsumeQuotaOverride
// ---------------------------------------------------------------------------

describe("checkAndConsumeQuotaOverride", () => {
  it("returns parsed OverrideRecord when UPDATE returns a row", async () => {
    const row = fakeRow({ id: 42n, single_use: true });
    const result = await checkAndConsumeQuotaOverride("test-agent", makeQuery([row]));
    expect(result).not.toBeNull();
    expect(result!.id).toBe(42);
    expect(result!.agentIdentity).toBe("test-agent");
    expect(result!.grantedBy).toBe("operator");
    expect(result!.singleUse).toBe(true);
    expect(result!.expiresAt).toBeInstanceOf(Date);
  });

  it("returns null when no row matches (UPDATE returns empty)", async () => {
    const result = await checkAndConsumeQuotaOverride("no-agent", makeQuery([]));
    expect(result).toBeNull();
  });

  it("returns null on DB error (fail-closed)", async () => {
    const result = await checkAndConsumeQuotaOverride("test-agent", makeErrorQuery());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkStandingOverride
// ---------------------------------------------------------------------------

describe("checkStandingOverride", () => {
  it("returns record without consuming (SELECT, not UPDATE)", async () => {
    const row = fakeRow({ single_use: false, override_reason: "permanent grant" });
    const result = await checkStandingOverride("test-agent", makeQuery([row]));
    expect(result).not.toBeNull();
    expect(result!.singleUse).toBe(false);
    expect(result!.overrideReason).toBe("permanent grant");
  });

  it("returns null when no standing override exists", async () => {
    const result = await checkStandingOverride("test-agent", makeQuery([]));
    expect(result).toBeNull();
  });

  it("returns null on DB error (fail-closed)", async () => {
    const result = await checkStandingOverride("test-agent", makeErrorQuery());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasActiveOverride
// ---------------------------------------------------------------------------

describe("hasActiveOverride", () => {
  it("prefers single-use over standing (returns single-use and does not call standing path)", async () => {
    // The single-use query returns a row, so standing is never reached.
    // We simulate this by making only the first call succeed.
    const singleRow = fakeRow({ id: 10n, single_use: true });
    let callCount = 0;
    const mockQuery: QueryFn = async (sql) => {
      callCount++;
      if (sql.includes("UPDATE")) return { rows: [singleRow] };
      return { rows: [] }; // standing should NOT be called
    };
    const result = await hasActiveOverride("test-agent", mockQuery);
    expect(result!.id).toBe(10);
    expect(result!.singleUse).toBe(true);
    // Only the UPDATE call should have been made (standing SELECT skipped).
    expect(callCount).toBe(1);
  });

  it("falls through to standing override when no single-use exists", async () => {
    const standingRow = fakeRow({ id: 20n, single_use: false });
    let callCount = 0;
    const mockQuery: QueryFn = async (sql) => {
      callCount++;
      if (sql.includes("UPDATE")) return { rows: [] };   // no single-use
      return { rows: [standingRow] };                     // standing exists
    };
    const result = await hasActiveOverride("test-agent", mockQuery);
    expect(result!.id).toBe(20);
    expect(result!.singleUse).toBe(false);
    expect(callCount).toBe(2);
  });

  it("returns null when neither single-use nor standing exists", async () => {
    const result = await hasActiveOverride("test-agent", makeQuery([]));
    // makeQuery([]) returns empty for both UPDATE and SELECT
    expect(result).toBeNull();
  });

  it("returns null on DB errors in both paths (fail-closed end-to-end)", async () => {
    // AC-10e: any DB error in the override check must never grant a bypass
    const result = await hasActiveOverride("test-agent", makeErrorQuery("network timeout"));
    expect(result).toBeNull();
  });
});
