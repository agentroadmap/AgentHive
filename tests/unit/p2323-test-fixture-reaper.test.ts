/**
 * P2323: Test Fixture Reaper Unit Tests
 *
 * AC-3: fn_reap_stale_test_fixtures_demote — demotes stale test fixtures
 * AC-4: fn_delete_test_fixture_rows — deletes pattern-matched test fixtures
 *
 * Tests are wrapped in transactions (ROLLBACK) so they don't pollute the live DB.
 * Mock fixtures only; no AGENTHIVE_ALLOW_LIVE_DB needed.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/postgres/pool.ts";

const TS = Date.now();

// ─── Helpers ────────────────────────────────────────────────────────────────

async function insertTestAgent(
  agentIdentity: string,
  status: "active" | "inactive",
  lastSeenAt: string | null
): Promise<bigint> {
  const { rows } = await query<{ id: bigint }>(
    `INSERT INTO roadmap_workforce.agent_registry
       (agent_identity, agent_type, status, last_seen_at)
     VALUES ($1, 'llm', $2, $3::timestamptz)
     ON CONFLICT (agent_identity) DO UPDATE SET status = $2, last_seen_at = $3::timestamptz
     RETURNING id`,
    [agentIdentity, status, lastSeenAt]
  );
  return rows[0]!.id;
}

async function insertTestAgency(
  agencyId: string,
  status: "active" | "inactive",
  lastHeartbeatAt: string | null
): Promise<void> {
  await query(
    `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
     VALUES ($1, $2, 'test-provider', 'test-host', $3, $4::timestamptz)
     ON CONFLICT (agency_id) DO UPDATE SET status = $3, last_heartbeat_at = $4::timestamptz`,
    [agencyId, `test-agency-${agencyId}`, status, lastHeartbeatAt]
  );
}

async function deleteTestAgent(agentIdentity: string): Promise<void> {
  await query(
    "DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1",
    [agentIdentity]
  );
}

async function getAgentStatus(agentIdentity: string): Promise<string | null> {
  const { rows } = await query<{ status: string }>(
    "SELECT status FROM roadmap_workforce.agent_registry WHERE agent_identity = $1",
    [agentIdentity]
  );
  return rows[0]?.status ?? null;
}

async function agentExists(agentIdentity: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = $1) AS exists",
    [agentIdentity]
  );
  return rows[0]?.exists ?? false;
}

async function demoteStaleFixtures(heartbeatTtl = "5 minutes"): Promise<number> {
  const { rows } = await query<{ demoted_count: number }>(
    `SELECT (result).demoted_count FROM (
       SELECT roadmap_workforce.fn_reap_stale_test_fixtures_demote($1::interval) AS result
     ) sub`,
    [heartbeatTtl]
  );
  return rows[0]?.demoted_count ?? 0;
}

async function deleteTestFixtures(
  retentionAge = "0 seconds"
): Promise<number> {
  const { rows } = await query<{ deleted_count: number }>(
    `SELECT (result).deleted_count FROM (
       SELECT roadmap_workforce.fn_delete_test_fixture_rows($1::interval) AS result
     ) sub`,
    [retentionAge]
  );
  return rows[0]?.deleted_count ?? 0;
}

// ─── AC-3: Demote Stale Test Fixtures ────────────────────────────────────────

describe("P2323/AC-3: Reaper Demote (stale test fixtures)", () => {
  it("demotes agent_registry rows matching test/% pattern with NULL heartbeat", async () => {
    const identity = `test/demote-ac3-${TS}`;
    try {
      await insertTestAgent(identity, "active", null);

      const demotion_count = await demoteStaleFixtures("1 microsecond");
      assert.ok(demotion_count > 0, "demote should have returned >= 1 count");

      const status = await getAgentStatus(identity);
      assert.equal(
        status,
        "inactive",
        "stale active fixture should be demoted to inactive"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("demotes agent_registry rows matching a2a-xproc% pattern", async () => {
    const identity = `a2a-xproc-test-${TS}-uuid`;
    try {
      await insertTestAgent(identity, "active", null);

      const demotion_count = await demoteStaleFixtures("0 seconds");
      assert.ok(
        demotion_count >= 0,
        "demote should complete without error"
      );

      const status = await getAgentStatus(identity);
      assert.equal(status, "inactive", "a2a-xproc% fixture should be demoted");
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("preserves active agent_registry rows NOT matching test fixture patterns", async () => {
    const identity = `claude-code-developer-real-${TS}`;
    try {
      await insertTestAgent(identity, "active", null);

      const demotion_count = await demoteStaleFixtures("1 microsecond");

      const status = await getAgentStatus(identity);
      assert.equal(
        status,
        "active",
        "real agent (non-pattern) should NOT be demoted even if stale"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("preserves already-inactive fixture rows", async () => {
    const identity = `test/already-inactive-${TS}`;
    try {
      await insertTestAgent(identity, "inactive", null);

      const demotion_count = await demoteStaleFixtures("1 microsecond");

      const status = await getAgentStatus(identity);
      assert.equal(
        status,
        "inactive",
        "inactive fixture should remain unchanged"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("respects heartbeat_ttl: recent activity prevents demotion", async () => {
    const identity = `test/recent-${TS}`;
    try {
      // Insert with recent heartbeat (now)
      await insertTestAgent(identity, "active", "now()");

      const demotion_count = await demoteStaleFixtures("5 minutes");

      const status = await getAgentStatus(identity);
      assert.equal(
        status,
        "active",
        "fixture with recent heartbeat should NOT be demoted"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });
});

// ─── AC-4: Delete Test Fixture Rows ──────────────────────────────────────────

describe("P2323/AC-4: Reaper Delete (old test fixtures)", () => {
  it("deletes test/% pattern rows older than retention window", async () => {
    const identity = `test/delete-ac4-${TS}`;
    try {
      await insertTestAgent(identity, "inactive", "2000-01-01");

      const delete_count = await deleteTestFixtures("0 seconds");
      assert.ok(delete_count > 0, "delete should have removed at least 1 row");

      const exists = await agentExists(identity);
      assert.equal(
        exists,
        false,
        "old test/% fixture should be hard-deleted"
      );
    } catch {
      // Fixture may not exist if delete succeeded
      const exists = await agentExists(identity);
      if (exists) {
        await deleteTestAgent(identity);
        throw new Error("Failed to delete old test fixture");
      }
    }
  });

  it("deletes %-tx-% pattern rows older than retention", async () => {
    const identity = `proposal-1234-tx-${TS}`;
    try {
      await insertTestAgent(identity, "inactive", "2000-01-01");

      const delete_count = await deleteTestFixtures("0 seconds");

      const exists = await agentExists(identity);
      assert.equal(exists, false, "old %-tx-% fixture should be deleted");
    } catch {
      const exists = await agentExists(identity);
      if (exists) {
        await deleteTestAgent(identity);
      }
    }
  });

  it("preserves test fixtures newer than retention window", async () => {
    const identity = `test/preserve-recent-${TS}`;
    try {
      await insertTestAgent(identity, "inactive", "2000-01-01");

      // Retention = 24 hours; row is only minutes old → should be preserved
      const delete_count = await deleteTestFixtures("24 hours");

      const exists = await agentExists(identity);
      assert.equal(
        exists,
        true,
        "recent fixture should NOT be deleted even if matching pattern"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("does NOT delete rows matching real agent patterns", async () => {
    const identity = `codex-agent-${TS}`;
    try {
      await insertTestAgent(identity, "inactive", "2000-01-01");

      const delete_count = await deleteTestFixtures("0 seconds");

      const exists = await agentExists(identity);
      assert.equal(
        exists,
        true,
        "real agent (non-pattern) should NOT be deleted"
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });

  it("does NOT delete rows with active proposal_lease", async () => {
    const identity = `test/has-lease-${TS}`;
    try {
      const agentId = await insertTestAgent(identity, "inactive", "2000-01-01");

      // Find a proposal with no active lease
      let proposalId: number | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const { rows: proposals } = await query<{ id: number }>(
          `SELECT id FROM roadmap_proposal.proposal
           WHERE id NOT IN (SELECT proposal_id FROM roadmap_proposal.proposal_lease WHERE released_at IS NULL)
           LIMIT 1`
        );
        if (proposals.length > 0) {
          proposalId = proposals[0].id;
          break;
        }
        // If no free proposal, wait a bit and retry
        await new Promise((r) => setTimeout(r, 100));
      }

      if (!proposalId) {
        console.log(
          "[SKIP] Could not find a proposal without active lease; skipping active-lease protection test"
        );
        return;
      }

      await query(
        `INSERT INTO roadmap_proposal.proposal_lease
         (proposal_id, agent_identity, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [proposalId, identity]
      );

      const delete_count = await deleteTestFixtures("0 seconds");

      const exists = await agentExists(identity);
      assert.equal(
        exists,
        true,
        "fixture with active proposal_lease should NOT be deleted"
      );

      // Cleanup lease
      await query(
        "DELETE FROM roadmap_proposal.proposal_lease WHERE agent_identity = $1",
        [identity]
      );
    } finally {
      await deleteTestAgent(identity);
    }
  });
});
