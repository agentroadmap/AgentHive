/**
 * P230: Layered Memory System — Integration Tests
 *
 * Verifies team_memory CRUD, context_packages cache + invalidation,
 * importance_score on agent_memory, and briefingAssemble proposal_context injection.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { query } from "../../src/infra/postgres/pool.js";
import { buildContextPackage } from "../../src/infra/agency/context_builder.js";
import { briefingAssemble } from "../../src/infra/agency/spawn-briefing-service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cleanTeam(team: string) {
  await query(
    `DELETE FROM roadmap_efficiency.team_memory WHERE team_name = $1`,
    [team],
  );
}

async function cleanContextPkg(proposalId: number) {
  await query(
    `DELETE FROM roadmap_efficiency.context_packages WHERE proposal_id = $1`,
    [proposalId],
  );
}

// ── AC-8 / AC-9: team_memory schema + CRUD ────────────────────────────────────

test("AC-8: team_memory table exists with correct columns", async () => {
  const { rows } = await query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'roadmap_efficiency' AND table_name = 'team_memory'
     ORDER BY column_name`,
  );
  const cols = rows.map((r) => r.column_name);
  for (const col of ["team_name", "memory_key", "memory_value", "expires_at", "access_count"]) {
    assert.ok(cols.includes(col), `Expected column: ${col}`);
  }
});

test("AC-9: team_mem CRUD round-trip", async () => {
  const team = "test-squad-p230";
  await cleanTeam(team);

  // Insert
  await query(
    `INSERT INTO roadmap_efficiency.team_memory
       (team_name, memory_key, memory_value, created_by)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (team_name, memory_key) DO UPDATE
       SET memory_value = EXCLUDED.memory_value, updated_at = now()`,
    [team, "arch-decision", JSON.stringify({ use_pg: true }), "test-agent"],
  );

  // Read back
  const { rows } = await query<{ memory_value: { use_pg: boolean } }>(
    `SELECT memory_value FROM roadmap_efficiency.team_memory
     WHERE team_name = $1 AND memory_key = $2`,
    [team, "arch-decision"],
  );
  assert.equal(rows.length, 1, "Expected 1 row");
  assert.deepEqual(rows[0].memory_value, { use_pg: true });

  await cleanTeam(team);
});

test("AC-14: team memory is readable by a different agent (cross-agent query)", async () => {
  const team = "test-squad-p230-cross";
  await cleanTeam(team);

  // Agent A writes
  await query(
    `INSERT INTO roadmap_efficiency.team_memory
       (team_name, memory_key, memory_value, created_by)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [team, "shared-key", JSON.stringify({ x: 42 }), "agent-a"],
  );

  // Agent B reads
  const { rows } = await query<{ memory_value: { x: number } }>(
    `SELECT memory_value FROM roadmap_efficiency.team_memory
     WHERE team_name = $1 AND memory_key = $2
       AND (expires_at IS NULL OR expires_at > now())`,
    [team, "shared-key"],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].memory_value, { x: 42 });

  await cleanTeam(team);
});

// ── AC-10: agent_memory importance_score column ───────────────────────────────

test("AC-10: agent_memory has importance_score column with correct constraint", async () => {
  const { rows } = await query<{ column_name: string; column_default: string }>(
    `SELECT column_name, column_default
     FROM information_schema.columns
     WHERE table_schema = 'roadmap_efficiency'
       AND table_name = 'agent_memory'
       AND column_name = 'importance_score'`,
  );
  assert.equal(rows.length, 1, "importance_score column should exist");
  assert.ok(rows[0].column_default.includes("5"), "Default should be 5");
});

// ── AC-11 / AC-12: context_packages caching ──────────────────────────────────

test("AC-11: buildContextPackage returns context and increments hit_count on second call", async () => {
  // Use a real proposal — pick the first available
  const { rows: proposals } = await query<{ id: number }>(
    `SELECT id FROM proposal LIMIT 1`,
  );
  if (!proposals.length) {
    console.log("SKIP: no proposals in DB");
    return;
  }
  const proposalId = proposals[0].id;
  await cleanContextPkg(proposalId);

  // First call — cache miss, builds and stores
  const ctx1 = await buildContextPackage({
    proposal_id: proposalId,
    package_type: "research",
    agent_id: "test-agent-p230",
  });
  assert.ok(typeof ctx1 === "string", "Should return string context");

  // Second call — cache hit, increments hit_count
  await buildContextPackage({
    proposal_id: proposalId,
    package_type: "research",
    agent_id: "test-agent-p230",
  });

  const { rows } = await query<{ hit_count: number }>(
    `SELECT hit_count FROM roadmap_efficiency.context_packages
     WHERE proposal_id = $1 AND package_type = $2`,
    [proposalId, "research"],
  );
  assert.ok(rows.length === 1, "Expected cached row");
  assert.ok(rows[0].hit_count >= 1, `hit_count should be >= 1, got ${rows[0].hit_count}`);

  await cleanContextPkg(proposalId);
});

test("AC-12: context package token_count <= 2000", async () => {
  const { rows: proposals } = await query<{ id: number }>(
    `SELECT id FROM proposal LIMIT 1`,
  );
  if (!proposals.length) {
    console.log("SKIP: no proposals in DB");
    return;
  }
  const proposalId = proposals[0].id;
  await cleanContextPkg(proposalId);

  await buildContextPackage({
    proposal_id: proposalId,
    package_type: "gate_review",
    agent_id: "test-agent-p230",
  });

  const { rows } = await query<{ token_count: number }>(
    `SELECT token_count FROM roadmap_efficiency.context_packages
     WHERE proposal_id = $1 AND package_type = $2`,
    [proposalId, "gate_review"],
  );
  if (rows.length && rows[0].token_count != null) {
    assert.ok(
      rows[0].token_count <= 2000,
      `token_count ${rows[0].token_count} exceeds 2000`,
    );
  }

  await cleanContextPkg(proposalId);
});

// ── AC-13: briefingAssemble injects proposal_context ─────────────────────────

test("AC-13: briefingAssemble with proposal_id injects proposal_context in inherited_memory", async () => {
  const { rows: proposals } = await query<{ id: number }>(
    `SELECT id FROM proposal LIMIT 1`,
  );
  if (!proposals.length) {
    console.log("SKIP: no proposals in DB");
    return;
  }
  const proposalId = BigInt(proposals[0].id);
  await cleanContextPkg(Number(proposalId));

  const briefing = await briefingAssemble(
    {
      task_id: "p230-test-briefing",
      mission: "Test proposal context injection",
      success_criteria: ["proposal_context appears in inherited_memory"],
      proposal_id: proposalId,
      context_package_type: "research",
    },
    "test-agent-p230",
  );

  const proposalContextEntry = briefing.inherited_memory.find(
    (m) => m.key === "proposal_context",
  );
  assert.ok(
    proposalContextEntry !== undefined,
    "inherited_memory should contain proposal_context key",
  );
  assert.ok(
    proposalContextEntry.body.length > 0,
    "proposal_context body should not be empty",
  );

  await cleanContextPkg(Number(proposalId));
});

// ── AC-16: context_packages invalidation trigger ──────────────────────────────

test("AC-16: context_packages row deleted on proposals.status UPDATE", async () => {
  const { rows: proposals } = await query<{ id: number; status: string }>(
    `SELECT id, status FROM proposal WHERE status = 'Draft' LIMIT 1`,
  );
  if (!proposals.length) {
    console.log("SKIP: no Draft proposals available");
    return;
  }
  const { id: proposalId, status: origStatus } = proposals[0];
  await cleanContextPkg(proposalId);

  // Insert a context_packages row
  await query(
    `INSERT INTO roadmap_efficiency.context_packages
       (proposal_id, package_type, context_text, token_count)
     VALUES ($1, 'code_gen', 'test context', 10)
     ON CONFLICT (proposal_id, package_type) DO NOTHING`,
    [proposalId],
  );

  const { rows: before } = await query<{ id: number }>(
    `SELECT id FROM roadmap_efficiency.context_packages WHERE proposal_id = $1`,
    [proposalId],
  );
  assert.ok(before.length >= 1, "Should have a cached row before trigger");

  // Touch proposal status (no-op status change to same value triggers the trigger)
  await query(
    `UPDATE proposal SET status = $1 WHERE id = $2`,
    ["Review", proposalId],
  );

  const { rows: after } = await query<{ id: number }>(
    `SELECT id FROM roadmap_efficiency.context_packages WHERE proposal_id = $1`,
    [proposalId],
  );
  assert.equal(after.length, 0, "context_packages row should be deleted after status change");

  // Restore
  await query(`UPDATE proposal SET status = $1 WHERE id = $2`, [origStatus, proposalId]);
});
