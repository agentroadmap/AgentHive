/**
 * P837: Liaison message service tests
 *
 * Tests verify:
 * - Mirror identity in message_ledger uses liaison: prefix
 * - Best-effort mirror failure handling
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { query, getPool, closePool } from "../postgres/pool.js";
import { storeMessage } from "./liaison-message-service.js";

const TEST_AGENCY_ID = "00000000-0000-4000-8000-000000000837";

async function setupTestDB() {
  const result = await query<{ "?column?": number }>("SELECT 1");
  assert.ok(result.rows.length > 0);
}

async function cleanupTestDB() {
  // Clean up test messages and ledger entries
  await query(
    "DELETE FROM roadmap.message_ledger WHERE channel LIKE $1",
    [`system:liaison:${TEST_AGENCY_ID}%`]
  );
  await query(
    "DELETE FROM roadmap.liaison_message WHERE agency_id = $1",
    [TEST_AGENCY_ID]
  );
}

test("Mirror identity test: from_agent uses liaison: prefix", async (t) => {
  await setupTestDB();
  try {
    const messageId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const signedAt = new Date().toISOString();

    // Store a message
    const stored = await storeMessage({
      message_id: messageId,
      agency_id: TEST_AGENCY_ID,
      direction: "orchestrator->liaison",
      kind: "test_message",
      correlation_id: correlationId,
      payload: { test: true },
      signed_at: signedAt,
      signature: "test-signature",
      sequence: BigInt(1),
    });

    // Verify the message was stored in liaison_message
    assert.strictEqual(stored.message_id, messageId);
    assert.strictEqual(stored.agency_id, TEST_AGENCY_ID);

    // Verify the mirror was written to message_ledger with correct from_agent
    const ledgerResult = await query<{
      id: number;
      from_agent: string;
      channel: string;
    }>(
      `SELECT id, from_agent, channel
       FROM roadmap.message_ledger
       WHERE channel = $1
       ORDER BY id DESC
       LIMIT 1`,
      [`system:liaison:${TEST_AGENCY_ID}`]
    );

    assert.ok(ledgerResult.rows.length > 0, "Message should be mirrored to ledger");
    const ledgerEntry = ledgerResult.rows[0];

    // The critical assertion: from_agent must use the liaison: prefix
    assert.strictEqual(
      ledgerEntry.from_agent,
      `liaison:${TEST_AGENCY_ID}`,
      "from_agent should use liaison: prefix matching agency_id"
    );

    // Verify the channel uses system:liaison: prefix (as it already did)
    assert.strictEqual(
      ledgerEntry.channel,
      `system:liaison:${TEST_AGENCY_ID}`,
      "channel should use system:liaison: prefix"
    );
  } finally {
    await cleanupTestDB();
  }
});

test("Mirror failure test: storeMessage succeeds even if ledger insert fails", async (t) => {
  await setupTestDB();
  try {
    const messageId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const signedAt = new Date().toISOString();
    const invalidAgencyId = "00000000-0000-4000-8000-000000000838";

    // Use a fake/invalid agency_id that doesn't exist in agent_registry
    // This will cause the ledger insert to fail (foreign key or constraint)
    // but storeMessage should still complete successfully
    const stored = await storeMessage({
      message_id: messageId,
      agency_id: invalidAgencyId,
      direction: "orchestrator->liaison",
      kind: "test_message",
      correlation_id: correlationId,
      payload: { test: true },
      signed_at: signedAt,
      signature: "test-signature",
      sequence: BigInt(1),
    });

    // The critical assertion: storeMessage returns successfully despite mirror failure
    assert.strictEqual(stored.message_id, messageId);
    assert.strictEqual(stored.agency_id, invalidAgencyId);

    // Verify the message WAS stored in liaison_message (authoritative store)
    const liaisonResult = await query<{ message_id: string }>(
      `SELECT message_id FROM roadmap.liaison_message WHERE message_id = $1`,
      [messageId]
    );
    assert.ok(
      liaisonResult.rows.length > 0,
      "Message should be stored in liaison_message even if mirror fails"
    );

    // Clean up
    await query(
      "DELETE FROM roadmap.liaison_message WHERE agency_id = $1",
      [invalidAgencyId]
    );
  } finally {
    // Nothing to clean up here since the invalid agency won't have ledger entries
  }
});
