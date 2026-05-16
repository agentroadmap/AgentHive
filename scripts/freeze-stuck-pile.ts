#!/usr/bin/env bun
/**
 * freeze-stuck-pile.ts
 *
 * One-shot operator script to freeze the pre-cutover stuck pile and write cutover stamp.
 * Must be run exactly once at read-flow cutover.
 *
 * Idempotent: ON CONFLICT (message_id) DO NOTHING ensures safe re-runs.
 *
 * Usage: bun scripts/freeze-stuck-pile.ts
 */

import { Client } from "pg";

const client = new Client({
  host: "127.0.0.1",
  user: "admin",
  database: "agenthive",
});

async function main() {
  try {
    await client.connect();

    // Step 1: Write the cutover stamp to feature_flag
    const cutoverNow = new Date().toISOString();
    const cutoverStampResult = await client.query(
      `
      INSERT INTO roadmap.feature_flag
        (flag_name, display_name, description, enabled_default, rollout_percent, updated_by)
      VALUES
        ('read_flow_cutover_at', 'Read Flow Cutover Timestamp', 'ISO8601 timestamp of pre-cutover stuck pile freeze', false, 100, 'operator-freeze-stuck-pile')
      ON CONFLICT (flag_name) DO NOTHING
      `,
    );
    console.log(`[1/2] Cutover stamp written: ${cutoverNow}`);

    // Step 2: Freeze the stuck pile
    // Capture all unread messages created before the cutover timestamp
    const freezeResult = await client.query(
      `
      INSERT INTO roadmap.pre_cutover_stuck_snapshot
        (message_id, from_agent, to_agent, message_type, created_at, read_at, acked_at)
      SELECT
        id, from_agent, to_agent, message_type, created_at, read_at, acked_at
      FROM roadmap.message_ledger
      WHERE read_at IS NULL
        AND created_at < $1::timestamptz
      ON CONFLICT (message_id) DO NOTHING
      `,
      [cutoverNow],
    );

    console.log(
      `[2/2] Snapshot frozen: ${freezeResult.rowCount} stuck pile rows captured`,
    );
    console.log(`Cutover at: ${cutoverNow}`);
  } catch (err) {
    console.error("Freeze failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
