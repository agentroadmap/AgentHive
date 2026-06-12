/**
 * P1352 AC-6 & AC-7: Memory Retrieval and TTL Decay Tests
 *
 * AC-6: Memory Retrieval in Spawn Briefing
 * - briefing_assemble() calls memoryService.getAgentMemory(liaison_agent_identity, 'semantic')
 * - Results filtered by expires_at IS NULL OR expires_at > NOW()
 * - Top-K by importance_score injected into inherited_memory
 * - Integration test: INSERT memory, call briefing_assemble(), assert inherited_memory contains entry
 *
 * AC-7: Memory Decay via TTL
 * - Expired agent_memory rows (expires_at < NOW()) are filtered out in spawn briefing assembly
 * - Query-time filter on expires_at > NOW() prevents stale entries
 * - Integration test: INSERT memory with past expires_at, call briefing_assemble(), assert NOT in inherited_memory
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { briefingAssemble, briefingLoad, type TaskContext } from "./spawn-briefing-service.js";
import { query } from "../postgres/pool.js";
import { MemoryService, type MemoryLayer } from "../../memory/memory_service.js";

// Helper to verify if AGENTHIVE_LIVE_DB_TESTS is enabled
const isLiveDbTestEnabled = () => process.env.AGENTHIVE_LIVE_DB_TESTS === "1";

/**
 * Register a test agent in agent_registry to satisfy FK constraint
 */
async function registerTestAgent(agentIdentity: string): Promise<void> {
  try {
    await query(
      `INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, preferred_model, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_identity) DO NOTHING`,
      [agentIdentity, "llm", "claude-opus-4-1", "developer"]
    );
  } catch (e) {
    // Non-fatal: agent may already exist
  }
}

/**
 * Clean up test agent from all tables
 */
async function cleanupTestAgent(agentIdentity: string): Promise<void> {
  try {
    await query(`DELETE FROM roadmap_efficiency.agent_memory WHERE agent_identity = $1`, [agentIdentity]);
    await query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [agentIdentity]);
  } catch (e) {
    // Non-fatal
  }
}

/**
 * AC-6: Memory Retrieval — Top-K by importance_score
 *
 * Test that briefing_assemble() correctly retrieves and injects semantic memory
 * entries into inherited_memory, ordered by importance_score DESC.
 */
test("P1352 AC-6: briefingAssemble retrieves semantic memory ordered by importance_score", { skip: !isLiveDbTestEnabled() }, async (t) => {
  const agentIdentity = `test-agent-ac6-${Date.now()}`;
  const memoryService = new MemoryService();

  // Register the test agent first
  await registerTestAgent(agentIdentity);

  // Create multiple semantic memory entries with different importance scores
  const memoryEntries = [
    { key: "pattern_A", value: { pattern: "A" }, score: 3 },
    { key: "pattern_B", value: { pattern: "B" }, score: 8 },
    { key: "pattern_C", value: { pattern: "C" }, score: 5 },
    { key: "pattern_D", value: { pattern: "D" }, score: 9 },
  ];

  // Insert memory entries
  for (const entry of memoryEntries) {
    await memoryService.setAgentMemory(
      agentIdentity,
      "semantic",
      entry.key,
      entry.value,
      null, // no TTL (expires_at = NULL)
      entry.score
    );
  }

  try {
    // Create a briefing
    const taskContext: TaskContext = {
      task_id: `P1352-ac6-test-${Date.now()}`,
      mission: "Test memory retrieval with importance_score ordering",
      success_criteria: ["Semantic memory injected in importance_score order"],
      liaison_agent: agentIdentity,
    };

    const briefing = await briefingAssemble(taskContext, agentIdentity);

    // Verify that semantic memory was injected
    const semanticEntry = briefing.inherited_memory.find((m) => m.key === "agent_memory:semantic");
    assert.ok(semanticEntry, "inherited_memory must contain agent_memory:semantic entry");

    // Parse the semantic memory
    const injectedMemory = JSON.parse(semanticEntry!.body) as Record<string, any>;

    // Verify that all entries are present
    assert.ok(injectedMemory.pattern_B, "pattern_B (score=8) should be present");
    assert.ok(injectedMemory.pattern_D, "pattern_D (score=9) should be present");
    assert.ok(injectedMemory.pattern_C, "pattern_C (score=5) should be present");
    assert.ok(injectedMemory.pattern_A, "pattern_A (score=3) should be present");

    // Verify the content of one entry
    assert.deepEqual(injectedMemory.pattern_D, { pattern: "D" }, "pattern_D value should be correct");

    // Verify order via database query (getAgentMemory should return in importance_score DESC order)
    const orderedMemory = await memoryService.getAgentMemory(agentIdentity, "semantic");
    const keys = Object.keys(orderedMemory);
    assert.equal(keys[0], "pattern_D", "First key should be pattern_D (score=9)");
    assert.equal(keys[1], "pattern_B", "Second key should be pattern_B (score=8)");
    assert.equal(keys[2], "pattern_C", "Third key should be pattern_C (score=5)");
    assert.equal(keys[3], "pattern_A", "Fourth key should be pattern_A (score=3)");

    console.log("✓ AC-6 test passed: semantic memory retrieved and ordered by importance_score");
  } finally {
    // Cleanup
    await cleanupTestAgent(agentIdentity);
  }
});

/**
 * AC-6: Top-K Limiting
 *
 * Test that briefing_assemble() limits to top-10 entries by importance_score
 * when retrieving semantic memory (preventing memory bloat).
 */
test("P1352 AC-6: briefingAssemble limits semantic memory to top-10 by importance_score", { skip: !isLiveDbTestEnabled() }, async (t) => {
  const agentIdentity = `test-agent-ac6-topk-${Date.now()}`;
  const memoryService = new MemoryService();

  await registerTestAgent(agentIdentity);

  // Create 15 memory entries with varying scores
  const memoryEntries = [];
  for (let i = 0; i < 15; i++) {
    memoryEntries.push({
      key: `pattern_${i}`,
      value: { pattern: i },
      score: Math.ceil(Math.random() * 10),
    });
  }

  // Insert all memory entries
  for (const entry of memoryEntries) {
    await memoryService.setAgentMemory(
      agentIdentity,
      "semantic",
      entry.key,
      entry.value,
      null,
      entry.score
    );
  }

  try {
    // Create a briefing
    const taskContext: TaskContext = {
      task_id: `P1352-ac6-topk-${Date.now()}`,
      mission: "Test memory limiting to top-10",
      success_criteria: ["Only top-10 semantic memory entries injected"],
      liaison_agent: agentIdentity,
    };

    const briefing = await briefingAssemble(taskContext, agentIdentity);

    const semanticEntry = briefing.inherited_memory.find((m) => m.key === "agent_memory:semantic");
    assert.ok(semanticEntry, "semantic memory should be present");

    const injectedMemory = JSON.parse(semanticEntry!.body) as Record<string, any>;
    const keyCount = Object.keys(injectedMemory).length;

    assert.equal(keyCount, 10, `Expected 10 entries, got ${keyCount} (limited to top-K by importance_score)`);

    console.log("✓ AC-6 top-K test passed: semantic memory limited to 10 entries");
  } finally {
    await cleanupTestAgent(agentIdentity);
  }
});

/**
 * AC-7: Memory Decay via TTL
 *
 * Test that expired memory entries (expires_at < NOW()) are filtered out
 * during briefing assembly and NOT injected into inherited_memory.
 */
test("P1352 AC-7: briefingAssemble filters out expired memory entries", { skip: !isLiveDbTestEnabled() }, async (t) => {
  const agentIdentity = `test-agent-ac7-${Date.now()}`;
  const memoryService = new MemoryService();

  await registerTestAgent(agentIdentity);

  try {
    // Insert a live memory entry (no TTL, never expires)
    await memoryService.setAgentMemory(
      agentIdentity,
      "semantic",
      "live_entry",
      { status: "live" },
      null, // no TTL
      5
    );

    // Insert an expired memory entry (expires_at in the past)
    // Use ttl_seconds = -1 to create an already-expired entry (trigger will set expires_at from created_at - 1 second, which is in past)
    await query(
      `INSERT INTO roadmap_efficiency.agent_memory
       (agent_identity, layer, key, value, ttl_seconds, importance_score, memory_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentIdentity,
        "semantic",
        "expired_entry",
        JSON.stringify({ status: "expired" }),
        -1, // negative ttl results in past expires_at
        8,
        "agent",
      ]
    );

    // Insert a memory entry that will expire soon (but not yet)
    // Use ttl_seconds = 3600 to expire in 1 hour from now
    await query(
      `INSERT INTO roadmap_efficiency.agent_memory
       (agent_identity, layer, key, value, ttl_seconds, importance_score, memory_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentIdentity,
        "semantic",
        "future_expire_entry",
        JSON.stringify({ status: "still_valid" }),
        3600, // expires in 1 hour
        7,
        "agent",
      ]
    );

    // Create a briefing
    const taskContext: TaskContext = {
      task_id: `P1352-ac7-test-${Date.now()}`,
      mission: "Test expired memory filtering",
      success_criteria: ["Expired entries not in inherited_memory"],
      liaison_agent: agentIdentity,
    };

    const briefing = await briefingAssemble(taskContext, agentIdentity);

    const semanticEntry = briefing.inherited_memory.find((m) => m.key === "agent_memory:semantic");
    assert.ok(semanticEntry, "semantic memory should be present");

    const injectedMemory = JSON.parse(semanticEntry!.body) as Record<string, any>;

    // Verify live entry is present
    assert.ok(injectedMemory.live_entry, "Live entry (no expiry) should be present");
    assert.deepEqual(injectedMemory.live_entry, { status: "live" }, "Live entry should have correct content");

    // Verify expired entry is NOT present
    assert.ok(
      !injectedMemory.expired_entry,
      "Expired entry (expires_at in past) should NOT be present"
    );

    // Verify future-expiring entry is present
    assert.ok(injectedMemory.future_expire_entry, "Future-expiring entry (expires_at in future) should be present");
    assert.deepEqual(injectedMemory.future_expire_entry, { status: "still_valid" }, "Future-expiring entry should have correct content");

    console.log("✓ AC-7 test passed: expired memory filtered, live entries injected");
  } finally {
    await cleanupTestAgent(agentIdentity);
  }
});

/**
 * AC-7: Memory Reaper via Query-Time Filtering
 *
 * Test that the v_active_memory view correctly filters expired rows
 * and that getAgentMemory respects this filtering.
 */
test("P1352 AC-7: v_active_memory view filters expired entries", { skip: !isLiveDbTestEnabled() }, async (t) => {
  const agentIdentity = `test-agent-ac7-reaper-${Date.now()}`;

  await registerTestAgent(agentIdentity);

  try {
    // Insert an expired entry directly (use negative ttl to create past expiry)
    await query(
      `INSERT INTO roadmap_efficiency.agent_memory
       (agent_identity, layer, key, value, ttl_seconds, importance_score, memory_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentIdentity,
        "semantic",
        "direct_expired",
        JSON.stringify({ type: "expired" }),
        -1, // negative ttl results in past expires_at
        5,
        "agent",
      ]
    );

    // Query via v_active_memory (should be filtered)
    const activeMemoryResult = await query(
      `SELECT COUNT(*) as cnt FROM roadmap.v_active_memory
       WHERE agent_identity = $1 AND layer = 'semantic' AND key = 'direct_expired'`,
      [agentIdentity]
    );

    assert.equal(
      parseInt(activeMemoryResult.rows[0].cnt as string),
      0,
      "v_active_memory should not return expired entries (expires_at < now())"
    );

    // Query the raw table (should show the entry)
    const rawTableResult = await query(
      `SELECT COUNT(*) as cnt FROM roadmap_efficiency.agent_memory
       WHERE agent_identity = $1 AND layer = 'semantic' AND key = 'direct_expired'`,
      [agentIdentity]
    );

    assert.equal(parseInt(rawTableResult.rows[0].cnt as string), 1, "Raw table should contain the expired entry for audit");

    console.log("✓ AC-7 reaper test passed: v_active_memory filters expired entries at query time");
  } finally {
    await cleanupTestAgent(agentIdentity);
  }
});

/**
 * AC-6 & AC-7 Integration: Full briefing flow with mixed memory states
 *
 * Test the full spawn briefing flow with:
 * - Live memory entries (no expiry)
 * - Expired entries (should be filtered)
 * - High importance entries (should rank higher)
 * - Low importance entries (should be lower, but included if within top-10)
 */
test("P1352 AC-6+AC-7 Integration: briefingAssemble with mixed memory states", { skip: !isLiveDbTestEnabled() }, async (t) => {
  const agentIdentity = `test-agent-integration-${Date.now()}`;
  const memoryService = new MemoryService();

  await registerTestAgent(agentIdentity);

  try {
    // Setup: Mix of entries with different states
    const baseTime = Date.now();

    // High-priority live entry
    await memoryService.setAgentMemory(agentIdentity, "semantic", "critical_insight", { value: "CRITICAL" }, null, 10);

    // Medium-priority live entry
    await memoryService.setAgentMemory(agentIdentity, "semantic", "useful_pattern", { value: "USEFUL" }, null, 7);

    // Low-priority live entry
    await memoryService.setAgentMemory(agentIdentity, "semantic", "nice_to_know", { value: "INFO" }, null, 2);

    // Expired entry (should be filtered - use negative ttl)
    await query(
      `INSERT INTO roadmap_efficiency.agent_memory
       (agent_identity, layer, key, value, ttl_seconds, importance_score, memory_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentIdentity,
        "semantic",
        "stale_data",
        JSON.stringify({ value: "STALE" }),
        -1, // negative ttl results in past expires_at
        9, // Even high score, still filtered
        "agent",
      ]
    );

    // Create briefing
    const taskContext: TaskContext = {
      task_id: `P1352-integration-${Date.now()}`,
      mission: "Integration test with mixed memory states",
      success_criteria: [
        "High-priority entries present",
        "Expired entries filtered",
        "Ordering by importance_score DESC",
      ],
      liaison_agent: agentIdentity,
    };

    const briefing = await briefingAssemble(taskContext, agentIdentity);

    const semanticEntry = briefing.inherited_memory.find((m) => m.key === "agent_memory:semantic");
    assert.ok(semanticEntry, "semantic memory should be present");

    const memory = JSON.parse(semanticEntry!.body) as Record<string, any>;

    // Verify ordering: critical (10) > useful (7) > nice_to_know (2)
    const keys = Object.keys(memory);
    assert.equal(keys[0], "critical_insight", "critical_insight (score=10) should be first");
    assert.equal(keys[1], "useful_pattern", "useful_pattern (score=7) should be second");
    assert.equal(keys[2], "nice_to_know", "nice_to_know (score=2) should be third");

    // Verify stale_data is NOT present
    assert.ok(!memory.stale_data, "stale_data (expired) should NOT be present");

    // Verify content
    assert.deepEqual(memory.critical_insight, { value: "CRITICAL" });
    assert.deepEqual(memory.useful_pattern, { value: "USEFUL" });
    assert.deepEqual(memory.nice_to_know, { value: "INFO" });

    console.log("✓ AC-6+AC-7 integration test passed: mixed memory states handled correctly");
  } finally {
    await cleanupTestAgent(agentIdentity);
  }
});

console.log("All P1352 AC-6 & AC-7 tests loaded (skipped if AGENTHIVE_LIVE_DB_TESTS !== 1)");
