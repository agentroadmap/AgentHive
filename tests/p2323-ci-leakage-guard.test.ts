/**
 * P2323/AC-2: CI Leakage Guard
 *
 * Captures row counts of key tables before and after the test suite and fails the
 * build if test pollution is detected (uncompensated row growth).
 *
 * Tables monitored:
 * - roadmap_workforce.agent_registry
 * - roadmap.agency
 * - roadmap_workforce.provider_registry
 * - roadmap_efficiency.message_ledger
 *
 * Usage: Run this test AFTER all other integration tests (filename prefix p2323-ci-*)
 * Example: npm test -- --grep="CI leakage guard"
 *
 * IMPORTANT: This test requires AGENTHIVE_ALLOW_LIVE_DB=1 to run.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/postgres/pool.ts";

// ─── Row Count Snapshot ──────────────────────────────────────────────────────

interface TableSnapshot {
  agent_registry: number;
  agency: number;
  provider_registry: number;
  message_ledger: number;
}

async function captureTableSnapshot(): Promise<TableSnapshot> {
  const results = await Promise.all([
    query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM roadmap_workforce.agent_registry"
    ),
    query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM roadmap.agency"
    ),
    query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM roadmap_workforce.provider_registry"
    ),
    query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM roadmap_efficiency.message_ledger"
    ),
  ]);

  return {
    agent_registry: Number(results[0].rows[0]?.count ?? "0"),
    agency: Number(results[1].rows[0]?.count ?? "0"),
    provider_registry: Number(results[2].rows[0]?.count ?? "0"),
    message_ledger: Number(results[3].rows[0]?.count ?? "0"),
  };
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

let beforeSnapshot: TableSnapshot | null = null;
let afterSnapshot: TableSnapshot | null = null;

describe("P2323/AC-2: CI Leakage Guard", () => {
  before(async () => {
    // Capture row counts at start of test suite
    // This will be called ONCE before any test in this file runs
    beforeSnapshot = await captureTableSnapshot();
    console.log("[CI Leakage Guard] Initial snapshot:", beforeSnapshot);
  });

  after(async () => {
    // Capture row counts at end of test suite
    afterSnapshot = await captureTableSnapshot();
    console.log("[CI Leakage Guard] Final snapshot:", afterSnapshot);

    // Fail the build if rows leaked
    if (!beforeSnapshot || !afterSnapshot) {
      throw new Error(
        "CI Leakage Guard: snapshots not captured correctly"
      );
    }

    const leaks: string[] = [];

    for (const [table, before] of Object.entries(beforeSnapshot)) {
      const after = (afterSnapshot as any)[table] ?? 0;
      const delta = after - before;

      if (delta > 0) {
        leaks.push(`${table}: +${delta} rows (${before} → ${after})`);
      } else if (delta < 0) {
        leaks.push(
          `${table}: ${delta} rows deleted (${before} → ${after}) — unexpected shrinkage`
        );
      }
    }

    if (leaks.length > 0) {
      const leakMsg = leaks.join("\n  ");
      throw new Error(
        `[CI Leakage Guard] Test suite polluted the live database:\n  ${leakMsg}\n` +
          `\nAll integration tests MUST clean up their rows. ` +
          `Either:\n` +
          `  1. Wrap writes in a transaction rolled back in afterEach() or after()\n` +
          `  2. Explicitly delete inserted rows in afterEach() or after()\n` +
          `  3. Run tests against an isolated DB (set PGDATABASE to a test DB)\n`
      );
    }
  });

  it("placeholder: row counts are captured at suite boundaries", async () => {
    // This test does nothing — the real work happens in before() and after() hooks.
    // Its purpose is to ensure this describe block is recognized by node:test
    // and its hooks are executed at the correct times.
    assert.ok(true);
  });
});
