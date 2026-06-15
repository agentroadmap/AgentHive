/**
 * P3313 AC-1: unit tests for decision-log-writer helpers.
 * Uses _setQueryForTest injection pattern (no live DB).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  writeRouteDecision,
  patchAdaptiveColumns,
  getRouteDecisionStats,
  _setQueryForTest,
} from "../../src/core/orchestration/decision-log-writer.ts";

// ---- Shared mock state ----
type Call = { sql: string; params: unknown[] };
const calls: Call[] = [];
let mockRowCount = 0;
let mockRows: unknown[] = [];

function resetMock(rowCount = 0, rows: unknown[] = []): void {
  calls.length = 0;
  mockRowCount = rowCount;
  mockRows = rows;
  _setQueryForTest(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: mockRows, rowCount: mockRowCount, command: "SELECT", oid: 0, fields: [] } as any;
  });
}

beforeEach(() => resetMock());

// ---------------------------------------------------------------------------

describe("writeRouteDecision", () => {
  it("inserts into roadmap.route_decision_log with all P3313 columns", async () => {
    resetMock(1);
    await writeRouteDecision({
      proposalId: 42,
      role: "developer",
      agencyIdentity: "claude-bot-gary.a",
      chosenRouteId: 7,
      eliminatedRoutes: [{ route_id: 3, route_provider: "openai", reason: "tier_too_low" }],
      difficultyScore: 0.75,
      requiredTier: "mid",
      reliabilityScore: 0.88,
      costRank: 2,
      chosenReason: "highest score within tier",
      taskClass: "code_dev",
    });

    assert.equal(calls.length, 1);
    const { sql, params } = calls[0];
    assert.ok(sql.includes("INSERT INTO roadmap.route_decision_log"), `wrong table: ${sql}`);
    assert.ok(sql.includes("difficulty_score"), "missing difficulty_score");
    assert.ok(sql.includes("required_tier"), "missing required_tier");
    assert.ok(sql.includes("reliability_score"), "missing reliability_score");
    assert.ok(sql.includes("cost_rank"), "missing cost_rank");
    assert.ok(sql.includes("chosen_reason"), "missing chosen_reason");
    assert.ok(sql.includes("task_class"), "missing task_class");
    // Positional params: $1=proposalId, $2=role, $3=agencyIdentity, $4=chosenRouteId,
    // $5=eliminatedRoutes (JSON), $6=difficulty, $7=tier, $8=reliability, $9=costRank,
    // $10=chosenReason, $11=taskClass
    assert.equal(params[0], 42);
    assert.equal(params[1], "developer");
    assert.equal(params[3], 7);
    assert.equal(params[5], 0.75);
    assert.equal(params[6], "mid");
    assert.equal(params[7], 0.88);
    assert.equal(params[8], 2);
    assert.equal(params[9], "highest score within tier");
    assert.equal(params[10], "code_dev");
  });

  it("writes null adaptive columns when not provided", async () => {
    resetMock(1);
    await writeRouteDecision({ proposalId: null, role: null, agencyIdentity: null, chosenRouteId: 5 });
    const { params } = calls[0];
    assert.deepEqual((params as unknown[]).slice(5), [null, null, null, null, null, null]);
  });

  it("serialises eliminatedRoutes as JSON string", async () => {
    resetMock(1);
    const elim = [{ route_id: 1, route_provider: "anthropic", reason: "quota" }];
    await writeRouteDecision({ proposalId: null, role: null, agencyIdentity: null, chosenRouteId: 5, eliminatedRoutes: elim });
    const { params } = calls[0];
    assert.equal(params[4], JSON.stringify(elim));
  });
});

// ---------------------------------------------------------------------------

describe("patchAdaptiveColumns", () => {
  it("returns true when rowCount=1", async () => {
    resetMock(1);
    const updated = await patchAdaptiveColumns(99, 7, { taskClass: "gate_review", reliabilityScore: 0.9 });
    assert.equal(updated, true);
  });

  it("returns false when rowCount=0", async () => {
    resetMock(0);
    const updated = await patchAdaptiveColumns(null, 99, { taskClass: "triage" });
    assert.equal(updated, false);
  });

  it("includes 60-second window guard in SQL", async () => {
    resetMock(1);
    await patchAdaptiveColumns(5, 3, { difficultyScore: 0.5, requiredTier: "lower" });
    const { sql, params } = calls[0];
    assert.ok(sql.includes("60 seconds"), "missing 60-second window guard");
    assert.equal(params[0], 3);   // chosenRouteId
    assert.equal(params[1], 5);   // proposalId
    assert.equal(params[2], 0.5); // difficultyScore
    assert.equal(params[3], "lower"); // requiredTier
  });

  it("passes null for omitted fields", async () => {
    resetMock(0);
    await patchAdaptiveColumns(null, 1, {});
    const { params } = calls[0];
    // params[2..7] = difficultyScore, requiredTier, reliability, costRank, chosenReason, taskClass
    assert.deepEqual((params as unknown[]).slice(2), [null, null, null, null, null, null]);
  });
});

// ---------------------------------------------------------------------------

describe("getRouteDecisionStats", () => {
  it("queries with default 7-day window", async () => {
    resetMock(0, []);
    await getRouteDecisionStats();
    assert.equal(calls[0]?.params[0], 7);
  });

  it("passes custom window days", async () => {
    resetMock(0, []);
    await getRouteDecisionStats(14);
    assert.equal(calls[0]?.params[0], 14);
  });

  it("returns row data from DB", async () => {
    const rows = [
      { task_class: "code_dev", route_id: 3, route_provider: "anthropic", avg_reliability: 0.9, decision_count: 5, last_seen: "2026-06-14" },
    ];
    resetMock(1, rows);
    const result = await getRouteDecisionStats();
    assert.equal(result.length, 1);
    assert.equal(result[0].task_class, "code_dev");
  });
});
