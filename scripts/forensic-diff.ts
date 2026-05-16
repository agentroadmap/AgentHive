#!/usr/bin/env bun
/**
 * forensic-diff.ts
 *
 * Daily forensic verifier for pre-cutover stuck pile integrity.
 * Cross-references snapshot against live message_ledger.
 *
 * Exit codes:
 *   0 = clean (no mutations)
 *   1 = drift detected (with diff report)
 *
 * Usage: bun scripts/forensic-diff.ts
 * For cron: 0 2 * * * cd /data/code/AgentHive && bun scripts/forensic-diff.ts >> /tmp/forensic-diff.log 2>&1
 */

import { Client } from "pg";

const client = new Client({
  host: "127.0.0.1",
  user: "admin",
  database: "agenthive",
});

interface SnapshotRow {
  message_id: bigint;
  read_at: string | null;
}

interface DiffEntry {
  message_id: bigint;
  expected_read_at: string | null;
  actual_read_at: string | null;
  issue: string;
}

async function main() {
  try {
    await client.connect();

    // Fetch snapshot rows
    const snapshotResult = await client.query(
      `
      SELECT message_id, read_at FROM roadmap.pre_cutover_stuck_snapshot
      ORDER BY message_id
      `,
    );
    const snapshotRows: SnapshotRow[] = snapshotResult.rows;

    if (snapshotRows.length === 0) {
      console.log("[INFO] No snapshot rows found (pre-cutover pile is empty)");
      process.exit(0);
    }

    const messageIds = snapshotRows.map((r) => r.message_id);

    // Fetch live rows for those IDs
    const liveResult = await client.query(
      `
      SELECT id, read_at FROM roadmap.message_ledger
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      `,
      [messageIds],
    );
    const liveRows: Record<bigint, string | null> = {};
    for (const row of liveResult.rows) {
      liveRows[row.id] = row.read_at;
    }

    // Row count check
    const missingCount = messageIds.length - liveResult.rows.length;
    if (missingCount > 0) {
      console.error(
        `[ERROR] Row count mismatch: snapshot has ${snapshotRows.length}, live query found ${liveResult.rows.length} (${missingCount} missing)`,
      );
    }

    // Validate each snapshot row
    const diffs: DiffEntry[] = [];
    for (const snap of snapshotRows) {
      const liveReadAt = liveRows[snap.message_id];

      if (liveReadAt === undefined) {
        diffs.push({
          message_id: snap.message_id,
          expected_read_at: snap.read_at,
          actual_read_at: undefined as any,
          issue: "DELETED from message_ledger",
        });
      } else if (snap.read_at === null && liveReadAt !== null) {
        diffs.push({
          message_id: snap.message_id,
          expected_read_at: snap.read_at,
          actual_read_at: liveReadAt,
          issue: `mutated: was unread, now read at ${liveReadAt}`,
        });
      } else if (snap.read_at !== null && snap.read_at !== liveReadAt) {
        diffs.push({
          message_id: snap.message_id,
          expected_read_at: snap.read_at,
          actual_read_at: liveReadAt,
          issue: `read_at changed from ${snap.read_at} to ${liveReadAt}`,
        });
      }
    }

    if (diffs.length === 0) {
      console.log(
        `[OK] Forensic check passed: ${snapshotRows.length} snapshot rows verified clean`,
      );
      process.exit(0);
    } else {
      console.error(
        `[DRIFT] ${diffs.length} row(s) mutated or missing:\n`,
      );
      for (const diff of diffs) {
        console.error(
          `  message_id=${diff.message_id}: ${diff.issue}`,
        );
      }
      process.exit(1);
    }
  } catch (err) {
    console.error("Forensic check failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
