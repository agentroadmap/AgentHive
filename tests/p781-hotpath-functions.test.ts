import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../infra/postgres/pool";

describe("P781: Hot-path function rewrites", () => {
  beforeAll(async () => {
    // Apply migration 215 if not already applied
    const result = await query(
      `SELECT COUNT(*) FROM roadmap.schema_migration WHERE filename = '215-p781-hotpath-shrink.sql'`
    );
    if ((result.rows[0] as any).count === 0) {
      console.log(
        "⚠️  Migration 215 not applied. Run: npm run migrate"
      );
    }
  });

  it("AC-P781-02: Functions contain zero legacy literal matches", async () => {
    const result = await query(`
      SELECT COUNT(*) as legacy_count
      FROM pg_proc p
      WHERE p.proname IN ('fn_notify_gate_ready','fn_sync_proposal_maturity','fn_lease_clear_maturity_on_release','fn_guard_terminal_maturity')
        AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
        AND pg_get_functiondef(p.oid) ~ 'TRIAGE|FIXING|\\bFIX\\b|DEPLOYED|\\bDONE\\b|ESCALATE|WONT_FIX|NON_ISSUE|REJECTED|DISCARDED|REPLACED'
    `);
    expect((result.rows[0] as any).legacy_count).toBe(0);
  });

  it("AC-P781-03: Functions use workflow_stages lookups", async () => {
    const result = await query(`
      SELECT COUNT(*) as workflow_count
      FROM pg_proc p
      WHERE p.proname IN ('fn_sync_proposal_maturity','fn_guard_terminal_maturity')
        AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
        AND pg_get_functiondef(p.oid) ~ 'is_terminal_stage'
    `);
    expect((result.rows[0] as any).workflow_count).toBe(2);
  });

  it("AC-P781-04: fn_notify_gate_ready emits orchestrator_wake", async () => {
    const result = await query(`
      SELECT COUNT(*) as wake_count
      FROM pg_proc p
      WHERE p.proname = 'fn_notify_gate_ready'
        AND p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
        AND pg_get_functiondef(p.oid) ~ 'orchestrator_wake'
    `);
    expect((result.rows[0] as any).wake_count).toBe(1);
  });

  it("AC-P781-05: fn_sync_proposal_maturity resets on non-terminal", async () => {
    const result = await query(`
      SELECT pg_get_functiondef(oid) as def
      FROM pg_proc
      WHERE proname = 'fn_sync_proposal_maturity'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
    `);
    const def = (result.rows[0] as any)?.def || "";
    // Verify it checks terminal status and resets maturity to 'new'
    expect(def).toContain("is_terminal_stage");
    expect(def).toContain("maturity := 'new'");
  });

  it("AC-P781-06: fn_lease_clear_maturity_on_release updates on release", async () => {
    const result = await query(`
      SELECT pg_get_functiondef(oid) as def
      FROM pg_proc
      WHERE proname = 'fn_lease_clear_maturity_on_release'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
    `);
    const def = (result.rows[0] as any)?.def || "";
    // Verify it detects release and updates maturity
    expect(def).toContain("released_at");
    expect(def).toContain("maturity");
  });

  it("AC-P781-08: fn_guard_terminal_maturity exists and uses workflow check", async () => {
    const result = await query(`
      SELECT COUNT(*) as guard_count
      FROM pg_proc
      WHERE proname = 'fn_guard_terminal_maturity'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
        AND pg_get_functiondef(oid) ~ 'is_terminal_stage'
    `);
    expect((result.rows[0] as any).guard_count).toBe(1);
  });

  it("AC-P781-09: Exhaustive scan finds zero legacy literals", async () => {
    const result = await query(`
      SELECT COUNT(*) as legacy_func_count
      FROM pg_proc
      WHERE pronamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('roadmap','roadmap_proposal','public'))
        AND prosrc ~ 'TRIAGE|FIXING|\\bFIX\\b|DEPLOYED|\\bDONE\\b|ESCALATE|WONT_FIX|NON_ISSUE|REJECTED|DISCARDED|REPLACED'
    `);
    expect((result.rows[0] as any).legacy_func_count).toBe(0);
  });

  it("AC-P781-Q2: orchestrator_wake payload has required fields", async () => {
    const result = await query(`
      SELECT pg_get_functiondef(oid) as def
      FROM pg_proc
      WHERE proname = 'fn_notify_gate_ready'
        AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'roadmap')
    `);
    const def = (result.rows[0] as any)?.def || "";
    const requiredFields = [
      "proposal_id",
      "display_id",
      "title",
      "type",
      "old_status",
      "old_maturity",
      "new_status",
      "new_maturity",
      "required_capabilities",
      "event_kind",
      "ts",
    ];
    for (const field of requiredFields) {
      expect(def).toContain(field);
    }
    // Verify no derived routing fields
    expect(def).not.toContain("to_stage");
    expect(def).not.toContain("gate");
  });
});
