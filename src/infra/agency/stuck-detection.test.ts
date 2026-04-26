/**
 * P467: Stuck-detection and auto-escalation tests
 *
 * Tests cover:
 * - Error signature computation and deduplication
 * - N-strikes rule enforcement
 * - Forced progress checkpoints
 * - Hard-stop budget enforcement
 * - Assistance request recording and tracking
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { query, closePool } from "../../postgres/pool.ts";
import {
  computeErrorSignature,
  getStrikeCount,
  incrementStrike,
  isCheckpointDue,
  recordProgressCheckpoint,
  incrementToolCallCount,
  recordAssistanceRequest,
  updateAssistanceRequest,
  getOpenAssistanceRequests,
  initSpawnBriefingConfig,
  getSpawnBriefingConfig,
  type ErrorSignature,
  type AssistancePayload,
} from "./stuck-detection.ts";

// Test setup: create test tables and cleanup
const TEST_BRIEFING_ID = "00000000-0000-4000-8000-000000000001";
const TEST_AGENCY_ID = "test-agency-1";
const TEST_AGENT_IDENTITY = "test-agent";
const TEST_TASK_ID = "task-001";

async function setupTestDB() {
  // Verify we can connect
  const result = await query<{ "?column?": number }>("SELECT 1");
  assert.ok(result.rows.length > 0, "Database connection failed");
}

async function cleanupTestDB() {
  // Clean up test data
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

test("Error signature computation", async (t) => {
  const error: ErrorSignature = {
    tool_name: "mcp_test_tool",
    error_class: "MissingParameterError",
    normalized_message: "parameter 'x' is required",
  };

  const sig = computeErrorSignature(error);
  assert.match(sig, /^[a-f0-9]{16}$/, "Signature should be 16-char hex");

  // Same input → same signature
  const sig2 = computeErrorSignature(error);
  assert.strictEqual(sig, sig2, "Signature must be deterministic");

  // Different error → different signature
  const error2: ErrorSignature = {
    tool_name: "mcp_test_tool",
    error_class: "TimeoutError",
    normalized_message: "operation timed out",
  };
  const sig3 = computeErrorSignature(error2);
  assert.notStrictEqual(sig, sig3, "Different errors should have different signatures");
});

test("Strike counting per spawn", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      request_assistance_threshold: 3,
    });

    const error: ErrorSignature = {
      tool_name: "test_tool",
      error_class: "TestError",
      normalized_message: "test error message",
    };
    const sig = computeErrorSignature(error);

    // First occurrence: should return 1
    let count = await incrementStrike(TEST_BRIEFING_ID, sig);
    assert.strictEqual(count, 1, "First strike should be count 1");

    // Second occurrence: should return 2
    count = await incrementStrike(TEST_BRIEFING_ID, sig);
    assert.strictEqual(count, 2, "Second strike should be count 2");

    // Third occurrence: should return 3
    count = await incrementStrike(TEST_BRIEFING_ID, sig);
    assert.strictEqual(count, 3, "Third strike should be count 3");

    // Verify retrieval
    const retrieved = await getStrikeCount(TEST_BRIEFING_ID, sig);
    assert.strictEqual(retrieved, 3, "Retrieved count should match");

    // Different signature: should start fresh
    const sig2 = computeErrorSignature({
      tool_name: "other_tool",
      error_class: "OtherError",
      normalized_message: "other error",
    });
    let count2 = await incrementStrike(TEST_BRIEFING_ID, sig2);
    assert.strictEqual(count2, 1, "Different signature starts fresh at 1");
  } finally {
    await cleanupTestDB();
  }
});

test("Forced progress checkpoints", async (t) => {
  await setupTestDB();
  try {
    const config = await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      checkpoint_interval: 3,
    });

    // Initially not due
    let due = await isCheckpointDue(TEST_BRIEFING_ID, config);
    assert.strictEqual(due, false, "Checkpoint should not be due on first check");

    // Increment tool calls
    for (let i = 0; i < 2; i++) {
      await incrementToolCallCount(TEST_BRIEFING_ID, config);
    }

    // Still not due (2 calls, interval is 3)
    due = await isCheckpointDue(TEST_BRIEFING_ID, config);
    assert.strictEqual(due, false, "Checkpoint should not be due at 2/3");

    // One more call
    await incrementToolCallCount(TEST_BRIEFING_ID, config);

    // Now due (3 calls >= 3 interval)
    due = await isCheckpointDue(TEST_BRIEFING_ID, config);
    assert.strictEqual(due, true, "Checkpoint should be due at 3/3");

    // Record checkpoint
    const success = await recordProgressCheckpoint({
      briefing_id: TEST_BRIEFING_ID,
      summary: "Made progress on task X",
      next_attempt: "Try approach Y",
      confidence: "med",
    });
    assert.strictEqual(success, true, "Checkpoint should be recorded");

    // After checkpoint, counter resets
    due = await isCheckpointDue(TEST_BRIEFING_ID, config);
    assert.strictEqual(due, false, "Checkpoint should not be due after reset");
  } finally {
    await cleanupTestDB();
  }
});

test("Hard-stop budget enforcement", async (t) => {
  await setupTestDB();
  try {
    const config = await initSpawnBriefingConfig(TEST_BRIEFING_ID, {
      max_tool_calls: 3,
    });

    // Make calls up to limit
    for (let i = 0; i < 3; i++) {
      const { exceeded, current_count } = await incrementToolCallCount(
        TEST_BRIEFING_ID,
        config
      );
      assert.strictEqual(exceeded, false, `Call ${i + 1} should not exceed budget`);
      assert.strictEqual(current_count, i + 1, `Count should be ${i + 1}`);
    }

    // One more call exceeds budget
    const { exceeded, current_count } = await incrementToolCallCount(
      TEST_BRIEFING_ID,
      config
    );
    assert.strictEqual(exceeded, true, "4th call should exceed budget");
    assert.strictEqual(current_count, 4, "Count should be 4");
  } finally {
    await cleanupTestDB();
  }
});

test("Assistance request lifecycle", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID);

    const payload: AssistancePayload = {
      briefing_id: TEST_BRIEFING_ID,
      task_id: TEST_TASK_ID,
      error_signature: "abc123",
      error_history: [
        {
          tool: "test_tool",
          error_class: "TestError",
          message: "Test error",
          ts: Date.now(),
        },
      ],
      what_i_tried: "Called test_tool 3 times",
      what_i_think: "Tool is broken",
      what_might_help: "Try different params",
      current_state_summary: "Stuck on test_tool",
      blocker_severity: "soft",
    };

    // Record request
    const request_id = await recordAssistanceRequest(
      TEST_AGENCY_ID,
      TEST_AGENT_IDENTITY,
      payload
    );
    assert.ok(request_id > 0, "Request ID should be positive");

    // Fetch open requests
    let openRequests = await getOpenAssistanceRequests(TEST_AGENCY_ID);
    assert.strictEqual(openRequests.length, 1, "Should have 1 open request");
    assert.strictEqual(openRequests[0].id, request_id, "Request ID should match");
    assert.strictEqual(openRequests[0].payload.blocker_severity, "soft");

    // Update to resolved
    await updateAssistanceRequest(request_id, "resolved", {
      solution: "Applied fallback",
    });

    // No more open requests
    openRequests = await getOpenAssistanceRequests(TEST_AGENCY_ID);
    assert.strictEqual(openRequests.length, 0, "Should have 0 open requests");
  } finally {
    await cleanupTestDB();
  }
});

test("Spawn briefing configuration", async (t) => {
  await setupTestDB();
  try {
    // Initialize with defaults
    let config = await initSpawnBriefingConfig(TEST_BRIEFING_ID);
    assert.strictEqual(config.request_assistance_threshold, 3);
    assert.strictEqual(config.checkpoint_interval, 5);
    assert.strictEqual(config.max_tool_calls, 100);

    // Retrieve from DB
    let retrieved = await getSpawnBriefingConfig(TEST_BRIEFING_ID);
    assert.ok(retrieved, "Config should be retrieved");
    assert.deepStrictEqual(config, retrieved, "Config should match");

    // Initialize with overrides
    const testBriefing2 = "00000000-0000-4000-8000-000000000002";
    const customConfig = await initSpawnBriefingConfig(testBriefing2, {
      request_assistance_threshold: 5,
      checkpoint_interval: 10,
      max_tool_calls: 200,
    });
    assert.strictEqual(customConfig.request_assistance_threshold, 5);
    assert.strictEqual(customConfig.checkpoint_interval, 10);
    assert.strictEqual(customConfig.max_tool_calls, 200);

    // Cleanup
    await query(
      "DELETE FROM roadmap.spawn_briefing_config WHERE briefing_id = $1",
      [testBriefing2]
    );
  } finally {
    await cleanupTestDB();
  }
});

// Cleanup after all tests
test.after(async () => {
  await closePool();
});
