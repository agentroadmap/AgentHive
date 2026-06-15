/**
 * P3313 AC-3: unit tests for reliability-floor-config.
 * Uses _setQueryForTest / _setNotifyForTest injection pattern (no live DB).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getReliabilityFloorSync,
  alertFloorViolation,
  getActiveOverrides,
  _setQueryForTest,
  _setNotifyForTest,
} from "../../src/core/orchestration/reliability-floor-config.ts";

type MockCall = { sql: string; params: unknown[] };

function makeQuery(rows: unknown[], rowCount = rows.length): (sql: string, params: unknown[]) => Promise<any> {
  return async (sql, params) => ({ rows, rowCount, command: "SELECT", oid: 0, fields: [] });
}
function makeQueryRecording(rows: unknown[] = []): { fn: (sql: string, params: unknown[]) => Promise<any>; calls: MockCall[] } {
  const calls: MockCall[] = [];
  return {
    calls,
    fn: async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; },
  };
}

// ---------------------------------------------------------------------------

describe("getReliabilityFloorSync", () => {
  it("returns value from map", () => {
    const m = new Map([["code_dev", 0.7], ["gate_review", 0.85]]);
    assert.equal(getReliabilityFloorSync("code_dev", m), 0.7);
    assert.equal(getReliabilityFloorSync("gate_review", m), 0.85);
  });

  it("returns 0.50 fallback for unknown task_class", () => {
    assert.equal(getReliabilityFloorSync("unknown_class", new Map()), 0.50);
  });

  it("returns 0.50 for empty map", () => {
    assert.equal(getReliabilityFloorSync("mechanical", new Map()), 0.50);
  });
});

// ---------------------------------------------------------------------------

describe("alertFloorViolation", () => {
  it("emits a WARN notification with floor info", async () => {
    const notifCalls: unknown[] = [];
    _setNotifyForTest(async (p: unknown) => { notifCalls.push(p); });
    _setQueryForTest(makeQuery([]));

    await alertFloorViolation({
      taskClass: "gate_review",
      floor: 0.85,
      bestReliability: 0.62,
      proposalId: 101,
    });

    assert.equal(notifCalls.length, 1);
    const call = notifCalls[0] as { severity: string; kind: string; body: string };
    assert.equal(call.severity, "WARN");
    assert.equal(call.kind, "floor_violation");
    assert.ok(call.body.includes("gate_review"), "body missing task_class");
    assert.ok(call.body.includes("0.85"), "body missing floor value");
    assert.ok(call.body.includes("0.620"), "body missing bestReliability");
    assert.ok(call.body.includes("proposal_id=101"), "body missing proposalId");
  });

  it("does not throw when enqueueNotification fails", async () => {
    _setNotifyForTest(async () => { throw new Error("network error"); });
    _setQueryForTest(makeQuery([]));
    await assert.doesNotReject(() =>
      alertFloorViolation({ taskClass: "merge", floor: 0.85, bestReliability: 0.5 }),
    );
  });

  it("includes BLOCKED text in notification body", async () => {
    const notifCalls: unknown[] = [];
    _setNotifyForTest(async (p: unknown) => { notifCalls.push(p); });
    _setQueryForTest(makeQuery([]));
    await alertFloorViolation({ taskClass: "architecture", floor: 0.85, bestReliability: 0.4 });
    const call = notifCalls[0] as { body: string };
    assert.ok(call.body.includes("BLOCKED"), "body should mention BLOCKED");
  });
});

// ---------------------------------------------------------------------------

describe("getActiveOverrides", () => {
  it("returns pin/ban entries from DB", async () => {
    const dbRows = [
      { route_id: 5, action: "ban" },
      { route_id: 7, action: "pin" },
    ];
    _setQueryForTest(makeQuery(dbRows));
    const overrides = await getActiveOverrides("gate_review");
    assert.equal(overrides.length, 2);
    assert.deepEqual(overrides[0], { route_id: 5, action: "ban" });
    assert.deepEqual(overrides[1], { route_id: 7, action: "pin" });
  });

  it("queries with task_class filter and expiry guard", async () => {
    const { fn, calls } = makeQueryRecording([]);
    _setQueryForTest(fn);
    await getActiveOverrides("code_dev");
    assert.ok(calls.length > 0, "no DB query made");
    const { sql, params } = calls[0];
    assert.ok(sql.includes("expires_at IS NULL OR expires_at > now()"), "missing expiry guard");
    assert.equal(params[0], "code_dev");
  });

  it("returns empty array when no overrides", async () => {
    _setQueryForTest(makeQuery([]));
    const overrides = await getActiveOverrides("triage");
    assert.deepEqual(overrides, []);
  });
});
