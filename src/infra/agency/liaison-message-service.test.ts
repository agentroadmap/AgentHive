/**
 * P837: Liaison message service tests
 *
 * Tests verify:
 * - Mirror identity in message_ledger uses liaison: prefix
 * - Best-effort mirror failure handling (liaison_message is authoritative)
 */

import { test } from "node:test";
import * as assert from "node:assert";
import { query } from "../postgres/pool.js";
import { storeMessage } from "./liaison-message-service.js";

// Human-readable agency_id values (agency_id is text, not UUID)
const TEST_AGENCY_ID = "test/agency-p837";
const TEST_AGENCY_ID_FAIL = "test/agency-p837-failure";
// liaison:${agency_id} is the expected from_agent value in message_ledger
const TEST_AGENT_IDENTITY = `liaison:${TEST_AGENCY_ID}`;
// hermes is a known host in roadmap.host_model_policy
const TEST_HOST_ID = "hermes";
// Project 1 is the canonical agenthive project
const TEST_PROJECT_ID = 1;

async function ensureAgency(agencyId: string) {
  // Register the liaison agent identity in agent_registry so the ledger FK is satisfied
  const agentIdentity = `liaison:${agencyId}`;
  await query(
    `INSERT INTO agent_registry
       (agent_identity, agent_type, trust_tier, status, project_id)
     VALUES ($1, 'agency', 'restricted', 'active', $2)
     ON CONFLICT (agent_identity) DO NOTHING`,
    [agentIdentity, TEST_PROJECT_ID]
  );

  await query(
    `INSERT INTO roadmap.agency
       (agency_id, display_name, provider, host_id, status)
     VALUES ($1, $2, 'test', $3, 'active')
     ON CONFLICT (agency_id) DO NOTHING`,
    [agencyId, `Test Agency ${agencyId}`, TEST_HOST_ID]
  );
}

async function cleanupAgency(agencyId: string) {
  const agentIdentity = `liaison:${agencyId}`;
  // liaison_message rows cascade-delete on agency delete
  await query(`DELETE FROM roadmap.message_ledger WHERE from_agent = $1`, [agentIdentity]);
  await query(`DELETE FROM roadmap.liaison_message WHERE agency_id = $1`, [agencyId]);
  await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agencyId]);
  await query(`DELETE FROM agent_registry WHERE agent_identity = $1`, [agentIdentity]);
}

test("Mirror identity test: from_agent uses liaison: prefix", async () => {
  await ensureAgency(TEST_AGENCY_ID);
  try {
    const messageId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const signedAt = new Date().toISOString();

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

    assert.strictEqual(stored.message_id, messageId);
    assert.strictEqual(stored.agency_id, TEST_AGENCY_ID);

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

    assert.ok(
      ledgerResult.rows.length > 0,
      "Message should be mirrored to ledger"
    );
    const ledgerEntry = ledgerResult.rows[0];

    // Critical assertion: from_agent must use liaison: prefix, not raw UUID
    assert.strictEqual(
      ledgerEntry.from_agent,
      `liaison:${TEST_AGENCY_ID}`,
      "from_agent should use liaison: prefix"
    );
    assert.strictEqual(
      ledgerEntry.channel,
      `system:liaison:${TEST_AGENCY_ID}`,
      "channel should use system:liaison: prefix"
    );
  } finally {
    await cleanupAgency(TEST_AGENCY_ID);
  }
});

test("Mirror failure test: storeMessage succeeds even if ledger insert fails", async () => {
  await ensureAgency(TEST_AGENCY_ID_FAIL);

  // Simulate ledger insert failure using a temp trigger that raises for this
  // specific test channel. The liaison agent identity is registered so the
  // agency insert succeeds, but the ledger mirror is blocked to verify
  // best-effort semantics.
  await query(`
    CREATE OR REPLACE FUNCTION roadmap._test_p837_block_ledger()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.from_agent = 'liaison:test/agency-p837-failure' THEN
        RAISE EXCEPTION 'P837 test: simulated ledger mirror failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await query(`
    CREATE TRIGGER _test_p837_block_ledger
    BEFORE INSERT ON roadmap.message_ledger
    FOR EACH ROW EXECUTE FUNCTION roadmap._test_p837_block_ledger()
  `);

  try {
    const messageId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const signedAt = new Date().toISOString();

    // storeMessage must succeed even though the ledger mirror will be blocked
    const stored = await storeMessage({
      message_id: messageId,
      agency_id: TEST_AGENCY_ID_FAIL,
      direction: "orchestrator->liaison",
      kind: "test_message",
      correlation_id: correlationId,
      payload: { test: true },
      signed_at: signedAt,
      signature: "test-signature",
      sequence: BigInt(1),
    });

    // Critical: liaison_message is authoritative — must be stored despite mirror failure
    assert.strictEqual(stored.message_id, messageId);
    assert.strictEqual(stored.agency_id, TEST_AGENCY_ID_FAIL);

    const liaisonResult = await query<{
      message_id: string;
      ledger_id: number | null;
    }>(
      `SELECT message_id, ledger_id
       FROM roadmap.liaison_message
       WHERE message_id = $1`,
      [messageId]
    );
    assert.ok(
      liaisonResult.rows.length > 0,
      "Message must be stored in liaison_message even when mirror fails"
    );
    // ledger_id should be NULL since the mirror was blocked
    assert.strictEqual(
      liaisonResult.rows[0].ledger_id,
      null,
      "ledger_id should be null when mirror fails (best-effort semantics)"
    );
  } finally {
    await query(
      `DROP TRIGGER IF EXISTS _test_p837_block_ledger ON roadmap.message_ledger`
    );
    await query(
      `DROP FUNCTION IF EXISTS roadmap._test_p837_block_ledger()`
    );
    await cleanupAgency(TEST_AGENCY_ID_FAIL);
  }
});
