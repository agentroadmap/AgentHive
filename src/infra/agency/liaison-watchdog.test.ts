/**
 * P467: Liaison watchdog tests
 *
 * Tests verify:
 * - Assistance request processing
 * - Watchdog cycle execution
 * - Action logging
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { query, closePool } from "../../postgres/pool.ts";
import {
  processAssistanceRequest,
  runWatchdogCycle,
  type WatchdogAction,
} from "./liaison-watchdog.ts";
import {
  recordAssistanceRequest,
  initSpawnBriefingConfig,
  type AssistancePayload,
} from "./stuck-detection.ts";

const TEST_BRIEFING_ID = "00000000-0000-4000-8000-000000000021";
const TEST_AGENCY_ID = "watchdog-test-agency";
const TEST_AGENT_IDENTITY = "test-agent";
const TEST_TASK_ID = "task-001";

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
    "DELETE FROM roadmap.spawn_briefing_config WHERE briefing_id = $1",
    [TEST_BRIEFING_ID]
  );
}

test("Process soft blocker assistance request", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID);

    const payload: AssistancePayload = {
      briefing_id: TEST_BRIEFING_ID,
      task_id: TEST_TASK_ID,
      error_signature: "error123",
      error_history: [
        {
          tool: "test_tool",
          error_class: "UnknownError",
          message: "Something went wrong",
          ts: Date.now(),
        },
      ],
      what_i_tried: "Called test_tool",
      what_i_think: "Tool behavior is unexpected",
      what_might_help: "Check documentation",
      current_state_summary: "Stuck on test_tool",
      blocker_severity: "soft",
    };

    const request_id = await recordAssistanceRequest(
      TEST_AGENCY_ID,
      TEST_AGENT_IDENTITY,
      payload
    );

    // Process the request
    const request = {
      id: request_id,
      briefing_id: TEST_BRIEFING_ID,
      task_id: TEST_TASK_ID,
      error_signature: "error123",
      payload,
      opened_at: new Date(),
    };

    const action = await processAssistanceRequest(request, TEST_AGENCY_ID);

    // Soft blocker with no playbook match → escalates
    assert.strictEqual(action.type, "escalate");
    assert.strictEqual(action.request_id, request_id);
    assert.ok(action.description.includes("Escalated soft blocker"));
  } finally {
    await cleanupTestDB();
  }
});

test("Process hard blocker assistance request", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID);

    const payload: AssistancePayload = {
      briefing_id: TEST_BRIEFING_ID,
      task_id: TEST_TASK_ID,
      error_signature: "hard-stop-budget",
      error_history: [
        {
          tool: "any",
          error_class: "BudgetExceeded",
          message: "Exceeded max tool calls",
          ts: Date.now(),
        },
      ],
      what_i_tried: "Made 100 tool calls",
      what_i_think: "Task too large for this spawn",
      what_might_help: "Re-scope or split into subtasks",
      current_state_summary: "Hard-stop budget exceeded",
      blocker_severity: "hard",
    };

    const request_id = await recordAssistanceRequest(
      TEST_AGENCY_ID,
      TEST_AGENT_IDENTITY,
      payload
    );

    const request = {
      id: request_id,
      briefing_id: TEST_BRIEFING_ID,
      task_id: TEST_TASK_ID,
      error_signature: "hard-stop-budget",
      payload,
      opened_at: new Date(),
    };

    const action = await processAssistanceRequest(request, TEST_AGENCY_ID);

    // Hard blocker → immediate escalation
    assert.strictEqual(action.type, "escalate");
    assert.ok(action.details?.severity === "hard");
    assert.ok(action.description.includes("hard-stop"));
  } finally {
    await cleanupTestDB();
  }
});

test("Watchdog cycle processes multiple requests", async (t) => {
  await setupTestDB();
  try {
    await initSpawnBriefingConfig(TEST_BRIEFING_ID);

    // Create multiple assistance requests
    const payload1: AssistancePayload = {
      briefing_id: TEST_BRIEFING_ID,
      task_id: "task-001",
      error_signature: "error1",
      error_history: [],
      what_i_tried: "Tried X",
      what_i_think: "Something failed",
      what_might_help: "Try Y",
      current_state_summary: "State 1",
      blocker_severity: "soft",
    };

    const payload2: AssistancePayload = {
      briefing_id: TEST_BRIEFING_ID,
      task_id: "task-002",
      error_signature: "error2",
      error_history: [],
      what_i_tried: "Tried A",
      what_i_think: "Something else failed",
      what_might_help: "Try B",
      current_state_summary: "State 2",
      blocker_severity: "soft",
    };

    const id1 = await recordAssistanceRequest(
      TEST_AGENCY_ID,
      TEST_AGENT_IDENTITY,
      payload1
    );
    const id2 = await recordAssistanceRequest(
      TEST_AGENCY_ID,
      TEST_AGENT_IDENTITY,
      payload2
    );

    // Run watchdog cycle
    const actions = await runWatchdogCycle(TEST_AGENCY_ID);

    // Should process both requests
    assert.strictEqual(actions.length, 2, "Should process both requests");
    assert.ok(
      actions.some((a) => a.request_id === id1),
      "Should process first request"
    );
    assert.ok(
      actions.some((a) => a.request_id === id2),
      "Should process second request"
    );

    // All should be escalated (no playbook matches)
    assert.strictEqual(
      actions.filter((a) => a.type === "escalate").length,
      2
    );
  } finally {
    await cleanupTestDB();
  }
});

test.after(async () => {
  await closePool();
});
