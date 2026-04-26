/**
 * P467: Tool call wrapper enforcement tests
 *
 * Tests verify:
 * - Checkpoint requirement blocking
 * - Error strike threshold blocking with auto-escalation
 * - Hard-stop budget blocking with auto-escalation
 * - Integration with stuck-detection infrastructure
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { query, closePool } from "../../postgres/pool.ts";
import {
  validateToolCall,
  checkErrorStrikes,
  checkHardStopBudget,
  checkCheckpointRequired,
  ToolCallError,
  type ToolCallContext,
} from "./tool-call-wrapper.ts";
import {
  initSpawnBriefingConfig,
  type ErrorSignature,
} from "./stuck-detection.ts";

const TEST_BRIEFING_ID = "00000000-0000-4000-8000-000000000011";
const TEST_AGENCY_ID = "wrapper-test-agency";
const TEST_CONTEXT: ToolCallContext = {
  briefing_id: TEST_BRIEFING_ID,
  agency_id: TEST_AGENCY_ID,
  agent_identity: "test-agent",
  task_id: "task-001",
};

async function setupTestDB() {
  const result = await query<{ "?column?": number }>("SELECT 1");
  assert.ok(result.rows.length > 0);
}

async function cleanupTestDB() {
  await query(
    "DELETE FROM roadmap.assistance_request WHERE briefing_id = $1",
    [TEST_BRIEFING_ID]
  );
  await query(
    "DELETE FROM roadmap.spawn_tool_call_counter WHERE briefing_id = $1",
    [TEST_BRIEFING_ID]
  );
  await query(
    "DELETE FROM roadmap.spawn_error_strike WHERE briefing_id = $1",
    [TEST_BRIEFING_ID]
  );
  await query(
    "DELETE FROM roadmap.spawn_briefing_config WHERE briefing_id = $1",
    [TEST_BRIEFING_ID]
  );
}

test("Checkpoint requirement blocking", async (t) => {
  await setupTestDB();
  try {
    const config = await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      checkpoint_interval: 2,
    });

    // First call should be allowed
    let result = await validateToolCall(TEST_CONTEXT, "tool_a", {}, []);
    assert.strictEqual(result.allowed, true, "First call should be allowed");

    // Second call should trigger checkpoint requirement (2 >= 2)
    let checkpointError: ToolCallError | null = null;
    try {
      await validateToolCall(TEST_CONTEXT, "tool_b", {}, []);
    } catch (error) {
      checkpointError = error as ToolCallError;
    }
    assert.ok(
      checkpointError && checkpointError.code === "CHECKPOINT_REQUIRED",
      "Second call should throw CHECKPOINT_REQUIRED"
    );
  } finally {
    await cleanupTestDB();
  }
});

test("Error strike threshold blocking and escalation", async (t) => {
  await setupTestDB();
  try {
    const config = await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      request_assistance_threshold: 2,
    });

    const error: ErrorSignature = {
      tool_name: "failing_tool",
      error_class: "NetworkError",
      normalized_message: "connection refused",
    };

    // First error: should not block
    let result = await checkErrorStrikes(TEST_CONTEXT, error, [
      {
        tool: "failing_tool",
        error_class: "NetworkError",
        message: "connection refused",
        ts: Date.now(),
      },
    ]);
    assert.strictEqual(result.blocked, false, "First strike should not block");
    assert.strictEqual(result.strike_count, 1);
    assert.strictEqual(result.escalated, false);

    // Second error (same signature): reaches threshold, triggers escalation
    result = await checkErrorStrikes(TEST_CONTEXT, error, [
      {
        tool: "failing_tool",
        error_class: "NetworkError",
        message: "connection refused",
        ts: Date.now(),
      },
    ]);
    assert.strictEqual(result.blocked, true, "Should block at threshold");
    assert.strictEqual(result.strike_count, 2);
    assert.strictEqual(result.escalated, true);
    assert.ok(result.request_id, "Should create assistance request");

    // Further calls should be immediately blocked
    result = await checkErrorStrikes(TEST_CONTEXT, error, []);
    assert.strictEqual(result.blocked, true, "Should remain blocked");
    assert.strictEqual(result.escalated, false, "Already escalated");
  } finally {
    await cleanupTestDB();
  }
});

test("Hard-stop budget escalation", async (t) => {
  await setupTestDB();
  try {
    const config = await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      max_tool_calls: 2,
    });

    // Make calls up to limit
    let result = await checkHardStopBudget(TEST_CONTEXT, []);
    assert.strictEqual(result.exceeded, false);
    assert.strictEqual(result.current_count, 1);

    result = await checkHardStopBudget(TEST_CONTEXT, []);
    assert.strictEqual(result.exceeded, false);
    assert.strictEqual(result.current_count, 2);

    // Third call exceeds budget and escalates
    result = await checkHardStopBudget(TEST_CONTEXT, [
      {
        tool: "some_tool",
        error_class: "Error",
        message: "budget exceeded",
        ts: Date.now(),
      },
    ]);
    assert.strictEqual(result.exceeded, true, "Should exceed budget");
    assert.strictEqual(result.current_count, 3);
    assert.strictEqual(result.escalated, true);
    assert.ok(result.request_id, "Should create assistance request");
  } finally {
    await cleanupTestDB();
  }
});

test("Integrated tool call validation", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      checkpoint_interval: 3,
      request_assistance_threshold: 2,
      max_tool_calls: 100,
    });

    // Scenario: tool repeatedly fails, then hits strike threshold
    const failingError: ErrorSignature = {
      tool_name: "unstable_tool",
      error_class: "TimeoutError",
      normalized_message: "timeout after 30s",
    };

    const recentErrors = [
      {
        error: failingError,
        ts: Date.now(),
      },
    ];

    // First call with recent error: should not block
    let result = await validateToolCall(
      TEST_CONTEXT,
      "unstable_tool",
      { param: "value" },
      recentErrors
    );
    assert.strictEqual(result.allowed, true);

    // Second call with same error: reaches threshold, should block
    let strikeError: ToolCallError | null = null;
    try {
      await validateToolCall(
        TEST_CONTEXT,
        "unstable_tool",
        { param: "value" },
        recentErrors
      );
    } catch (error) {
      strikeError = error as ToolCallError;
    }
    assert.ok(
      strikeError && strikeError.code === "ERROR_STRIKE_THRESHOLD_EXCEEDED",
      "Should throw ERROR_STRIKE_THRESHOLD_EXCEEDED"
    );
  } finally {
    await cleanupTestDB();
  }
});

test.after(async () => {
  await closePool();
});
