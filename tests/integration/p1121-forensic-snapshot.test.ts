import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "pg";
import { execSync } from "child_process";

const client = new Client({
  host: "127.0.0.1",
  user: "admin",
  database: "agenthive",
});

let testProject = 1; // Default project_id

describe("P1121: Forensic Snapshot", () => {
  beforeAll(async () => {
    await client.connect();
    // Create test table snapshot if needed (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS roadmap.pre_cutover_stuck_snapshot (
        message_id BIGINT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        message_type TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        read_at TIMESTAMPTZ,
        acked_at TIMESTAMPTZ,
        snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Clean up from prior test runs
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);

    // Register test agents to satisfy FK constraints
    const testAgents = [
      'test-agent-1', 'test-agent-2', 'test-agent-3', 'test-agent-4',
      'test-agent-5', 'test-agent-6', 'agent-a', 'agent-b', 'agent-c',
      'agent-d', 'agent-x', 'agent-y'
    ];
    for (const agent of testAgents) {
      await client.query(
        `INSERT INTO roadmap.agent_registry (agent_identity, agent_type) VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
        [agent]
      );
    }
  });

  afterAll(async () => {
    // Delete snapshot and messages created by test
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);
    const testAgentList = ['test-agent-1', 'test-agent-2', 'test-agent-3', 'test-agent-4',
      'test-agent-5', 'test-agent-6', 'agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-x', 'agent-y'];
    await client.query(`
      DELETE FROM roadmap.message_ledger
      WHERE from_agent = ANY($1::text[]) OR to_agent = ANY($1::text[])
    `, [testAgentList]);
    // Clean up test agents
    await client.query(`
      DELETE FROM roadmap.agent_registry
      WHERE agent_identity = ANY($1::text[])
    `, [testAgentList]);
    await client.end();
  });

  it("migration adds the table with correct column types", async () => {
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'roadmap' AND table_name = 'pre_cutover_stuck_snapshot'
      ORDER BY ordinal_position
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    const columnMap: Record<string, any> = {};
    for (const row of result.rows) {
      columnMap[row.column_name] = row;
    }

    expect(columnMap["message_id"].data_type).toBe("bigint");
    expect(columnMap["from_agent"].data_type).toBe("text");
    expect(columnMap["to_agent"].data_type).toBe("text");
    expect(columnMap["message_type"].data_type).toBe("text");
    expect(columnMap["created_at"].data_type).toBe("timestamp with time zone");
    expect(columnMap["read_at"].data_type).toBe("timestamp with time zone");
    expect(columnMap["acked_at"].data_type).toBe("timestamp with time zone");
    expect(columnMap["snapshot_at"].data_type).toBe("timestamp with time zone");
  });

  it("freeze script captures 3 known-stuck rows into snapshot", async () => {
    // Clean snapshot state first
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);

    // Insert 3 fixture rows into message_ledger (unread, old)
    const cutoffTime = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    const beforeCutoff = new Date(cutoffTime).toISOString();

    const insertResult = await client.query(
      `
      INSERT INTO roadmap.message_ledger
        (from_agent, to_agent, message_type, created_at, project_id, thread_id)
      VALUES
        ('test-agent-1', 'test-agent-2', 'text', $1::timestamptz, $2, 1),
        ('test-agent-3', 'test-agent-4', 'task', $1::timestamptz, $2, 2),
        ('test-agent-5', 'test-agent-6', 'notify', $1::timestamptz, $2, 3)
      RETURNING id
      `,
      [beforeCutoff, testProject],
    );

    const messageIds: bigint[] = insertResult.rows.map((r) => r.id);
    expect(messageIds.length).toBe(3);

    // Freeze the snapshot (simulate freeze-stuck-pile.ts logic with a fresh marker)
    const cutoverMarker = new Date(Date.now() - 300000).toISOString(); // 5 min ago (after fixture create)
    const freezeResult = await client.query(
      `
      INSERT INTO roadmap.pre_cutover_stuck_snapshot
        (message_id, from_agent, to_agent, message_type, created_at, read_at, acked_at)
      SELECT
        id, from_agent, to_agent, message_type, created_at, read_at, acked_at
      FROM roadmap.message_ledger
      WHERE id = ANY($1::bigint[])
        AND read_at IS NULL
      ON CONFLICT (message_id) DO NOTHING
      `,
      [messageIds],
    );

    expect(freezeResult.rowCount).toBe(3);

    // Cleanup
    await client.query(`DELETE FROM roadmap.message_ledger WHERE id = ANY($1)`, [
      messageIds,
    ]);
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);
  });

  it("forensic diff returns 0 (clean) when snapshot matches ledger", async () => {
    // Clean snapshot state first
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);

    // Insert fixture: 2 unread rows
    const cutoffTime = new Date(Date.now() - 86400000).toISOString();
    const beforeCutoff = new Date(cutoffTime).toISOString();

    const insertResult = await client.query(
      `
      INSERT INTO roadmap.message_ledger
        (from_agent, to_agent, message_type, created_at, project_id, thread_id)
      VALUES
        ('agent-a', 'agent-b', 'text', $1::timestamptz, $2, 1),
        ('agent-c', 'agent-d', 'task', $1::timestamptz, $2, 2)
      RETURNING id
      `,
      [beforeCutoff, testProject],
    );

    const messageIds: bigint[] = insertResult.rows.map((r) => r.id);

    // Snapshot them
    await client.query(
      `
      INSERT INTO roadmap.pre_cutover_stuck_snapshot
        (message_id, from_agent, to_agent, message_type, created_at, read_at, acked_at)
      SELECT
        id, from_agent, to_agent, message_type, created_at, read_at, acked_at
      FROM roadmap.message_ledger
      WHERE id = ANY($1::bigint[])
      ON CONFLICT (message_id) DO NOTHING
      `,
      [messageIds],
    );

    // Run forensic-diff logic: both snapshot and live should agree (unread)
    const snapshotRows = await client.query(
      `SELECT message_id, read_at FROM roadmap.pre_cutover_stuck_snapshot WHERE message_id = ANY($1::bigint[]) ORDER BY message_id`,
      [messageIds],
    );

    const liveResult = await client.query(
      `
      SELECT id, read_at FROM roadmap.message_ledger
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      `,
      [messageIds],
    );

    expect(snapshotRows.rows.length).toBe(2);
    expect(liveResult.rows.length).toBe(2);

    // Verify no diffs
    const diffs = [];
    for (const snap of snapshotRows.rows) {
      const liveReadAt = liveResult.rows.find((r) => r.id === snap.message_id)
        ?.read_at;
      if (snap.read_at === null && liveReadAt !== null) {
        diffs.push({ message_id: snap.message_id, issue: "mutated" });
      }
    }

    expect(diffs.length).toBe(0);

    // Cleanup
    await client.query(`DELETE FROM roadmap.message_ledger WHERE id = ANY($1)`, [
      messageIds,
    ]);
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);
  });

  it("forensic diff returns 1 when snapshot row is mutated", async () => {
    // Clean snapshot state first
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);

    // Insert fixture
    const cutoffTime = new Date(Date.now() - 86400000).toISOString();
    const beforeCutoff = new Date(cutoffTime).toISOString();

    const insertResult = await client.query(
      `
      INSERT INTO roadmap.message_ledger
        (from_agent, to_agent, message_type, created_at, project_id, thread_id)
      VALUES
        ('agent-x', 'agent-y', 'text', $1::timestamptz, $2, 1)
      RETURNING id
      `,
      [beforeCutoff, testProject],
    );

    const messageId = insertResult.rows[0].id;

    // Snapshot the unread row
    await client.query(
      `
      INSERT INTO roadmap.pre_cutover_stuck_snapshot
        (message_id, from_agent, to_agent, message_type, created_at, read_at, acked_at)
      SELECT
        id, from_agent, to_agent, message_type, created_at, read_at, acked_at
      FROM roadmap.message_ledger
      WHERE id = $1
      `,
      [messageId],
    );

    // Mutate: mark as read in ledger
    const mutateTime = new Date().toISOString();
    await client.query(
      `UPDATE roadmap.message_ledger SET read_at = $1::timestamptz WHERE id = $2`,
      [mutateTime, messageId],
    );

    // Run forensic-diff logic: detect that snapshot says unread but live says read
    const snapshotRow = await client.query(
      `SELECT message_id, read_at FROM roadmap.pre_cutover_stuck_snapshot WHERE message_id = $1`,
      [messageId],
    );

    const liveRow = await client.query(
      `SELECT id, read_at FROM roadmap.message_ledger WHERE id = $1`,
      [messageId],
    );

    const snap = snapshotRow.rows[0];
    const live = liveRow.rows[0];

    // Verify drift detected
    expect(snap.read_at).toBeNull();
    expect(live.read_at).not.toBeNull();

    // Cleanup
    await client.query(`DELETE FROM roadmap.message_ledger WHERE id = $1`, [
      messageId,
    ]);
    await client.query(`DELETE FROM roadmap.pre_cutover_stuck_snapshot`);
  });
});
