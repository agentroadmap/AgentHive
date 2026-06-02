/**
 * P466: Spawn Briefing Service Tests
 *
 * Tests for briefing assembly, loading, summary emission, and harvester validation.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  briefingAssemble,
  briefingLoad,
  childBootCheckBriefing,
  emitSpawnSummary,
  type TaskContext,
  type SpawnBriefing,
} from "./spawn-briefing-service.js";
import { query } from "../postgres/pool.js";

test("briefingAssemble: creates briefing with mission and constraints", async (t) => {
  const taskContext: TaskContext = {
    task_id: "P466-test-001",
    mission: "Test spawn briefing assembly and memory inheritance",
    success_criteria: [
      "Briefing created with all required fields",
      "Memory entries inherited from knowledge base",
      "MCP quirks fetched and included",
    ],
    done_signal: "ac-pass",
    allowed_tools: ["add_discussion", "prop_transition"],
    forbidden_tools: ["git_push"],
    budget: {
      max_tokens: 50000,
      max_minutes: 30,
      max_tool_calls: 100,
    },
    stop_conditions: ["tests fail twice in a row", "3 strikes same error"],
    parent_agent: "liaison-orchestrator",
    liaison_agent: "agency-liaison",
    rescue_team_channel: "chan_escalation",
    request_assistance_threshold: 3,
    topic_keywords: ["spawn", "briefing"],
  };

  const briefing = await briefingAssemble(taskContext, "test-agent");

  assert.ok(briefing.briefing_id, "briefing_id should be generated");
  assert.equal(briefing.task_id, "P466-test-001");
  assert.equal(briefing.mission, taskContext.mission);
  assert.deepEqual(briefing.success_criteria, taskContext.success_criteria);
  assert.equal(briefing.done_signal, "ac-pass");
  assert.deepEqual(briefing.allowed_tools, ["add_discussion", "prop_transition"]);
  assert.deepEqual(briefing.forbidden_tools, ["git_push"]);
  assert.equal(briefing.budget.max_tokens, 50000);
  assert.equal(briefing.budget.max_minutes, 30);
  assert.equal(briefing.budget.max_tool_calls, 100);
  assert.deepEqual(briefing.stop_conditions, taskContext.stop_conditions);
  assert.equal(briefing.parent_agent, "liaison-orchestrator");
  assert.equal(briefing.liaison_agent, "agency-liaison");
  assert.equal(briefing.rescue_team_channel, "chan_escalation");
  assert.equal(briefing.request_assistance_threshold, 3);
  assert.equal(briefing.briefed_by, "test-agent");

  // Verify briefing is persisted in DB
  const persisted = await query(
    `SELECT briefing_id FROM roadmap.spawn_briefing WHERE briefing_id = $1`,
    [briefing.briefing_id]
  );
  assert.equal(persisted.rowCount, 1, "Briefing should be persisted in DB");
});

test("briefingAssemble: defaults for optional fields", async (t) => {
  const taskContext: TaskContext = {
    task_id: "P466-test-002",
    mission: "Minimal briefing test",
    success_criteria: ["Task completes"],
    // All optional fields omitted
  };

  const briefing = await briefingAssemble(taskContext, "test-agent");

  assert.equal(briefing.done_signal, "ac-pass", "done_signal should default to ac-pass");
  assert.deepEqual(briefing.allowed_tools, [], "allowed_tools should default to empty");
  assert.deepEqual(briefing.forbidden_tools, [], "forbidden_tools should default to empty");
  assert.equal(briefing.budget.max_tokens, null, "max_tokens should default to null");
  assert.equal(briefing.parent_agent, null, "parent_agent should default to null");
  assert.equal(briefing.request_assistance_threshold, 3, "request_assistance_threshold should default to 3");
});

test("briefingLoad: retrieves briefing by ID", async (t) => {
  const taskContext: TaskContext = {
    task_id: "P466-test-003",
    mission: "Load briefing test",
    success_criteria: ["Briefing loaded successfully"],
  };

  const assembled = await briefingAssemble(taskContext, "test-agent");
  const loaded = await briefingLoad(assembled.briefing_id);

  assert.deepEqual(loaded.task_id, assembled.task_id);
  assert.deepEqual(loaded.mission, assembled.mission);
  assert.deepEqual(loaded.success_criteria, assembled.success_criteria);
});

test("briefingLoad: throws if briefing not found", async (t) => {
  const nonExistentId = "00000000-0000-0000-0000-000000000000";

  let error: Error | null = null;
  try {
    await briefingLoad(nonExistentId);
  } catch (e) {
    error = e as Error;
  }

  assert.ok(error, "Should throw error for non-existent briefing");
  assert.match(error!.message, /not found/);
  assert.match(error!.message, /fail-closed/);
});

test("childBootCheckBriefing: fails if briefing_id missing", async (t) => {
  let error: Error | null = null;

  try {
    await childBootCheckBriefing(undefined);
  } catch (e) {
    error = e as Error;
  }

  assert.ok(error, "Should throw for missing briefing_id");
  assert.match(error!.message, /briefing_id is required/);
  assert.match(error!.message, /fail-closed|Parent must call/);
});

test("childBootCheckBriefing: loads and returns briefing if exists", async (t) => {
  const taskContext: TaskContext = {
    task_id: "P466-test-004",
    mission: "Child boot check test",
    success_criteria: ["Boot check passes"],
  };

  const assembled = await briefingAssemble(taskContext, "test-agent");
  const loaded = await childBootCheckBriefing(assembled.briefing_id);

  assert.deepEqual(loaded.briefing_id, assembled.briefing_id);
});

test("emitSpawnSummary: records completion with findings and quirks", async (t) => {
  // First create a briefing
  const taskContext: TaskContext = {
    task_id: "P466-test-005",
    mission: "Spawn summary test",
    success_criteria: ["Task succeeds"],
  };

  const briefing = await briefingAssemble(taskContext, "test-agent");

  // Emit a completion summary
  const summary = {
    briefing_id: briefing.briefing_id,
    outcome: "success" as const,
    summary: "Task completed successfully",
    new_findings: [
      {
        date: new Date().toISOString(),
        summary: "Discovered that add_discussion requires proposal_id, not proposal_slug",
        proposal: "P466",
      },
    ],
    updated_quirks: [
      {
        tool: "add_discussion",
        canonical_args: { proposal_id: "text", author: "text", content: "text" },
        gotchas: ["proposal_id must be numeric string, not UUID"],
      },
    ],
    tool_calls_made: 15,
    tokens_used: 8500,
    duration_seconds: 45.5,
    emitted_by: "child-agent-001",
  };

  await emitSpawnSummary(summary);

  // Verify summary is recorded
  const recorded = await query(
    `SELECT briefing_id, outcome, tool_calls_made, tokens_used
     FROM roadmap.spawn_summary WHERE briefing_id = $1`,
    [briefing.briefing_id]
  );

  assert.equal(recorded.rowCount, 1, "Summary should be recorded");
  const row = recorded.rows[0];
  assert.equal(row.outcome, "success");
  assert.equal(row.tool_calls_made, 15);
  assert.equal(row.tokens_used, 8500);
});

test("emitSpawnSummary: records failure with error log", async (t) => {
  const taskContext: TaskContext = {
    task_id: "P466-test-006",
    mission: "Spawn failure summary test",
    success_criteria: ["Task fails gracefully"],
  };

  const briefing = await briefingAssemble(taskContext, "test-agent");

  const summary = {
    briefing_id: briefing.briefing_id,
    outcome: "failure" as const,
    summary: "Task failed with validation error",
    new_findings: [
      {
        date: new Date().toISOString(),
        summary: "MCP tool returned unexpected error: CHECK constraint failed on gate-decision prefix",
        proposal: "P466",
      },
    ],
    updated_quirks: [],
    tool_calls_made: 7,
    error_log: {
      error_signature: "mcp_prop_transition_check_constraint",
      error_message: 'CHECK constraint "proposal_status_prefix" violated',
      tool: "prop_transition",
    },
    state_snapshot: {
      last_tool_call: "prop_transition",
      last_attempt_args: { proposal_id: "P450", to_state: "Review" },
    },
    emitted_by: "child-agent-002",
  };

  await emitSpawnSummary(summary);

  const recorded = await query(
    `SELECT outcome, error_log FROM roadmap.spawn_summary WHERE briefing_id = $1`,
    [briefing.briefing_id]
  );

  assert.equal(recorded.rowCount, 1);
  assert.equal(recorded.rows[0].outcome, "failure");
  assert.ok(recorded.rows[0].error_log, "Error log should be recorded");
});

test("spawn_briefing: constraints enforced", async (t) => {
  // Test empty task_id constraint
  let error: Error | null = null;

  try {
    await query(
      `INSERT INTO roadmap.spawn_briefing
       (briefing_id, task_id, mission, success_criteria, done_signal, parent_agent, briefed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["00000000-0000-0000-0000-000000000001", "", "mission", "[]", "ac-pass", null, "test"]
    );
  } catch (e) {
    error = e as Error;
  }

  assert.ok(error, "Should enforce task_id non-empty constraint");
});

test("fallback_playbook: records error recovery patterns", async (t) => {
  const sig = `test_sig_${Date.now()}`;
  // Insert a fallback playbook entry
  await query(
    `INSERT INTO roadmap.fallback_playbook
     (error_signature, tool_name, error_class, try_action, confidence, source_proposal)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sig,
      "add_discussion_test",
      "ValidationError",
      "Include proposal_id (numeric string) in MCP call arguments",
      0.95,
      "P450",
    ]
  );

  const result = await query(
    `SELECT error_signature, tool_name, try_action, confidence
     FROM roadmap.fallback_playbook
     WHERE error_signature = $1`,
    [sig]
  );

  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].tool_name, "add_discussion_test");
  // PostgreSQL numeric type returns as string
  assert.equal(String(result.rows[0].confidence), "0.95");
});

test("mcp_tool_schema: canonical params and gotchas", async (t) => {
  const toolName = `test_tool_${Date.now()}`;
  // Insert MCP tool schema
  await query(
    `INSERT INTO roadmap.mcp_tool_schema
     (tool_name, mcp_server, canonical_args, known_gotchas)
     VALUES ($1, $2, $3, $4)`,
    [
      toolName,
      "agenthive",
      JSON.stringify({
        proposal_id: "text (numeric string, not UUID)",
        author: "text",
        content: "text",
      }),
      JSON.stringify([
        {
          issue: "proposal_id must be numeric string, not UUID",
          workaround: "Convert UUID to proposal.id before calling",
        },
      ]),
    ]
  );

  const result = await query(
    `SELECT tool_name, canonical_args, known_gotchas
     FROM roadmap.mcp_tool_schema
     WHERE tool_name = $1`,
    [toolName]
  );

  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.ok(row.canonical_args.proposal_id);
  assert.equal(row.known_gotchas.length, 1);
  assert.match(row.known_gotchas[0].issue, /numeric string/);
});

test("P194 AC-8: briefingAssemble loads project_memory and agent semantic memory", async (t) => {
  const agentIdentity = `test-agent-p194-${Date.now()}`;

  // Pre-seed semantic memory for this agent
  await query(
    `INSERT INTO workforce.agent_memory (agent_identity, layer, key, value, ttl_seconds, expires_at)
     VALUES ($1, 'semantic', 'p194_test_key', $2, NULL, NULL)
     ON CONFLICT (agent_identity, layer, key) DO UPDATE SET value = EXCLUDED.value`,
    [agentIdentity, JSON.stringify({ fact: "p194_test_value" })]
  );

  const taskContext: TaskContext = {
    task_id: `P194-ac8-test-${Date.now()}`,
    mission: "AC-8 test: verify project and agent memory are loaded",
    success_criteria: ["inherited_memory contains project_memory:architecture", "inherited_memory contains agent_memory:semantic:p194_test_key"],
    liaison_agent: agentIdentity,
  };

  const briefing = await briefingAssemble(taskContext, "test-orchestrator");

  // AC-8: project_memory['architecture'] must be in inherited_memory
  const archEntry = briefing.inherited_memory.find((m) => m.key === "project_memory:architecture");
  assert.ok(archEntry, "inherited_memory must include project_memory:architecture");
  const archContent = JSON.parse(archEntry!.body);
  assert.ok(archContent.pillars, "architecture entry must have pillars key");

  // AC-8: agent_memory['semantic'] entries must be in inherited_memory
  const semanticEntry = briefing.inherited_memory.find((m) => m.key === "agent_memory:semantic:p194_test_key");
  assert.ok(semanticEntry, "inherited_memory must include agent_memory:semantic:p194_test_key");
  const semanticContent = JSON.parse(semanticEntry!.body);
  assert.equal(semanticContent.fact, "p194_test_value");

  // AC-8: cache_control must be present
  assert.ok(briefing.cache_control, "cache_control must be present in briefing");
  assert.equal(briefing.cache_control?.type, "ephemeral");

  // Cleanup
  await query(
    `DELETE FROM workforce.agent_memory WHERE agent_identity = $1`,
    [agentIdentity]
  );
});

console.log("All P466 spawn briefing service tests passed");
