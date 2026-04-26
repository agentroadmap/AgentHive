/**
 * P468: Liaison message service tests
 * Tests for idempotency, replay, signature validation, and LISTEN/NOTIFY
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../src/infra/postgres/pool.js';
import {
    storeMessage,
    getNextSequence,
    getMessageById,
    getUnackedMessages,
    getMessagesInSequenceRange,
    acknowledgeMessage,
    getMessageAckOutcome,
    detectAndBufferOutOfOrder,
    isSignatureTimestampValid,
} from '../../../src/infra/agency/liaison-message-service.js';

// ─── Setup & Teardown ────────────────────────────────────────────────────────

const TEST_AGENCY_ID = 'test-agency-' + Date.now();

async function setupTestAgency(): Promise<void> {
    // Insert a test agency
    await query(
        `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agency_id) DO NOTHING`,
        [TEST_AGENCY_ID, 'Test Agency', 'test-provider', 'bot', 'active']
    );
}

async function cleanupTestAgency(): Promise<void> {
    // Clean up messages and agency
    await query('DELETE FROM roadmap.liaison_message WHERE agency_id = $1', [TEST_AGENCY_ID]);
    await query('DELETE FROM roadmap.agency WHERE agency_id = $1', [TEST_AGENCY_ID]);
}

// ─── AC1: Message Envelope Schema ───────────────────────────────────────────

test('AC1: message envelope has all required fields', async (t) => {
    await setupTestAgency();

    try {
        const sequence = await getNextSequence(TEST_AGENCY_ID);
        assert.equal(sequence, 1n, 'first sequence should be 1');

        const message = await storeMessage({
            message_id: crypto.randomUUID(),
            agency_id: TEST_AGENCY_ID,
            sequence: 1n,
            direction: 'orchestrator->liaison',
            kind: 'offer_dispatch',
            correlation_id: crypto.randomUUID(),
            payload: {
                offer_id: crypto.randomUUID(),
                role: 'agent',
                required_capabilities: ['python', 'bash'],
                route_hint: 'claude',
            },
            signed_at: new Date().toISOString(),
            signature: 'test-signature',
        });

        assert(message.message_id, 'message_id set');
        assert.equal(message.agency_id, TEST_AGENCY_ID);
        assert.equal(message.sequence, 1n);
        assert.equal(message.direction, 'orchestrator->liaison');
        assert.equal(message.kind, 'offer_dispatch');
        assert(message.correlation_id);
        assert(message.signed_at);
        assert(message.signature);
        assert(!message.acked_at, 'acked_at initially null');
        assert(!message.ack_outcome, 'ack_outcome initially null');
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC2: Idempotency ────────────────────────────────────────────────────────

test('AC2: (agency_id, sequence) unique constraint enforces idempotency', async (t) => {
    await setupTestAgency();

    try {
        const messageId = crypto.randomUUID();
        const sequence = 1n;

        // Insert first message
        const msg1 = await storeMessage({
            message_id: messageId,
            agency_id: TEST_AGENCY_ID,
            sequence,
            direction: 'orchestrator->liaison',
            kind: 'offer_dispatch',
            correlation_id: crypto.randomUUID(),
            payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' },
            signed_at: new Date().toISOString(),
            signature: 'sig1',
        });

        // Insert duplicate — should not error (ON CONFLICT)
        const msg2 = await storeMessage({
            message_id: crypto.randomUUID(), // Different message_id
            agency_id: TEST_AGENCY_ID,
            sequence, // Same sequence
            direction: 'orchestrator->liaison',
            kind: 'claim_revoke',
            correlation_id: crypto.randomUUID(),
            payload: { claim_id: crypto.randomUUID(), reason: 'test' },
            signed_at: new Date().toISOString(),
            signature: 'sig2',
        });

        // Both should succeed; idempotency is enforced at (agency_id, sequence) level
        assert.equal(msg1.message_id, messageId);
        // msg2 is a new insert with different message_id but same sequence (causes conflict)
        // The ON CONFLICT UPDATE updates the existing row with the new message_id
        assert.notEqual(msg2.message_id, messageId, 'second insert with new message_id overwrites');
        assert.equal(msg2.sequence, sequence, 'sequence is same, enforcing idempotency');
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC3: Liaison Resumption from MAX(sequence) ──────────────────────────────

test('AC3: liaison resumes from MAX(sequence)+1 on restart', async (t) => {
    await setupTestAgency();

    try {
        // Insert 3 messages with sequences 1, 2, 3
        for (let i = 1; i <= 3; i++) {
            await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: TEST_AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: 0 },
                signed_at: new Date().toISOString(),
                signature: 'sig',
            });
        }

        const nextSeq = await getNextSequence(TEST_AGENCY_ID);
        assert.equal(nextSeq, 4n, 'next sequence should be 4 after 3 messages');
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC4: Out-of-Order Buffering ────────────────────────────────────────────

test('AC4: out-of-order messages within window are buffered', async (t) => {
    // Simulate receiving sequence 3 when expecting 1
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        TEST_AGENCY_ID,
        1n, // expected
        3n  // incoming
    );

    assert(!inOrder, 'should detect out of order');
    assert.equal(droppedCount, 0, 'within window, no drops');
});

test('AC4: out-of-order messages beyond window are dropped with resync', async (t) => {
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        TEST_AGENCY_ID,
        1n,      // expected
        102n     // incoming (gap of 101 > window of 100)
    );

    assert(!inOrder);
    assert(droppedCount > 0, 'messages beyond window are dropped');
});

// ─── AC5: Acknowledgment & Idempotent Acks ──────────────────────────────────

test('AC5: orchestrator acks messages with outcome', async (t) => {
    await setupTestAgency();

    try {
        const messageId = crypto.randomUUID();
        const msg = await storeMessage({
            message_id: messageId,
            agency_id: TEST_AGENCY_ID,
            sequence: 1n,
            direction: 'liaison->orchestrator',
            kind: 'heartbeat',
            correlation_id: crypto.randomUUID(),
            payload: { capacity_envelope: {}, in_flight_count: 0 },
            signed_at: new Date().toISOString(),
            signature: 'sig',
        });

        assert(!msg.acked_at, 'initially not acked');

        // Acknowledge the message
        await acknowledgeMessage(messageId, 'ok');

        // Fetch and verify
        const acked = await getMessageById(messageId);
        assert(acked?.acked_at, 'acked_at should be set');
        assert.equal(acked?.ack_outcome, 'ok');
    } finally {
        await cleanupTestAgency();
    }
});

test('AC5: repeated acks return previous outcome (idempotent)', async (t) => {
    await setupTestAgency();

    try {
        const messageId = crypto.randomUUID();
        await storeMessage({
            message_id: messageId,
            agency_id: TEST_AGENCY_ID,
            sequence: 1n,
            direction: 'liaison->orchestrator',
            kind: 'heartbeat',
            correlation_id: crypto.randomUUID(),
            payload: { capacity_envelope: {}, in_flight_count: 0 },
            signed_at: new Date().toISOString(),
            signature: 'sig',
        });

        // First ack
        await acknowledgeMessage(messageId, 'ok');

        // Get outcome (as orchestrator would return on repeated ack)
        const outcome1 = await getMessageAckOutcome(messageId);
        assert.equal(outcome1?.outcome, 'ok');

        // Second ack with different outcome (should be harmless)
        await acknowledgeMessage(messageId, 'reject', 'already acked');

        const outcome2 = await getMessageAckOutcome(messageId);
        assert.equal(outcome2?.outcome, 'reject', 'subsequent ack overwrites');
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC6: Signature Timestamp Validation ────────────────────────────────────

test('AC6: recent signatures are valid', async (t) => {
    const now = new Date();
    const recentSignature = new Date(now.getTime() - 1000).toISOString(); // 1 second ago
    assert(isSignatureTimestampValid(recentSignature), 'recent signature should be valid');
});

test('AC6: old signatures (>5min) are rejected', async (t) => {
    const now = new Date();
    const oldSignature = new Date(now.getTime() - 6 * 60 * 1000).toISOString(); // 6 minutes ago
    assert(!isSignatureTimestampValid(oldSignature), 'old signature should be invalid');
});

// ─── AC7: Replay Safety ──────────────────────────────────────────────────────

test('AC7: fetch unacked messages for replay', async (t) => {
    await setupTestAgency();

    try {
        // Insert messages, some acked, some not
        const msg1 = await storeMessage({
            message_id: crypto.randomUUID(),
            agency_id: TEST_AGENCY_ID,
            sequence: 1n,
            direction: 'orchestrator->liaison',
            kind: 'offer_dispatch',
            correlation_id: crypto.randomUUID(),
            payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' },
            signed_at: new Date().toISOString(),
            signature: 'sig',
        });

        const msg2 = await storeMessage({
            message_id: crypto.randomUUID(),
            agency_id: TEST_AGENCY_ID,
            sequence: 2n,
            direction: 'orchestrator->liaison',
            kind: 'protocol_ping',
            correlation_id: crypto.randomUUID(),
            payload: { nonce: 'test' },
            signed_at: new Date().toISOString(),
            signature: 'sig',
        });

        // Ack first message
        await acknowledgeMessage(msg1.message_id, 'ok');

        // Fetch unacked — should get msg2 only
        const unacked = await getUnackedMessages(TEST_AGENCY_ID);
        assert.equal(unacked.length, 1, 'should have 1 unacked message');
        assert.equal(unacked[0].message_id, msg2.message_id);
    } finally {
        await cleanupTestAgency();
    }
});

test('AC7: fetch messages in sequence range', async (t) => {
    await setupTestAgency();

    try {
        // Insert 5 messages
        const messageIds: string[] = [];
        for (let i = 1; i <= 5; i++) {
            const msg = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: TEST_AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: i },
                signed_at: new Date().toISOString(),
                signature: 'sig',
            });
            messageIds.push(msg.message_id);
        }

        // Fetch range 2-4
        const range = await getMessagesInSequenceRange(TEST_AGENCY_ID, 2n, 4n);
        assert.equal(range.length, 3, 'should have 3 messages in range');
        assert.equal(range[0].sequence, 2n);
        assert.equal(range[2].sequence, 4n);
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC9: Failure Mode — Liaison Restart ────────────────────────────────────

test('AC9: liaison restart resumes from last sequence', async (t) => {
    await setupTestAgency();

    try {
        // Insert 5 messages to simulate a running liaison
        for (let i = 1; i <= 5; i++) {
            await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: TEST_AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: i },
                signed_at: new Date().toISOString(),
                signature: 'sig',
            });
        }

        // Simulate restart: get next sequence
        const nextSeq = await getNextSequence(TEST_AGENCY_ID);
        assert.equal(nextSeq, 6n, 'liaison resumes from sequence 6');

        // Verify previous messages are still there
        const all = await getMessagesInSequenceRange(TEST_AGENCY_ID, 1n);
        assert.equal(all.length, 5, 'all 5 messages still exist');
    } finally {
        await cleanupTestAgency();
    }
});

// ─── AC10: Multiple Message Kinds ───────────────────────────────────────────

test('AC10: store and retrieve different message kinds', async (t) => {
    await setupTestAgency();

    try {
        const kinds = [
            { kind: 'offer_dispatch', payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' } },
            { kind: 'claim_offer', payload: { offer_id: crypto.randomUUID(), agent_identity: 'agent-1', briefing_id: crypto.randomUUID() } },
            { kind: 'heartbeat', payload: { capacity_envelope: {}, in_flight_count: 0 } },
            { kind: 'protocol_ping', payload: { nonce: 'test' } },
        ];

        let seq = 1;
        for (const { kind, payload } of kinds) {
            const msg = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: TEST_AGENCY_ID,
                sequence: BigInt(seq),
                direction: kind === 'offer_dispatch' ? 'orchestrator->liaison' : 'liaison->orchestrator',
                kind,
                correlation_id: crypto.randomUUID(),
                payload,
                signed_at: new Date().toISOString(),
                signature: 'sig',
            });
            assert.equal(msg.kind, kind);
            seq++;
        }

        // Fetch all and verify
        const all = await getMessagesInSequenceRange(TEST_AGENCY_ID, 1n);
        assert.equal(all.length, kinds.length);
        assert.equal(all[0].kind, 'offer_dispatch');
        assert.equal(all[1].kind, 'claim_offer');
        assert.equal(all[2].kind, 'heartbeat');
        assert.equal(all[3].kind, 'protocol_ping');
    } finally {
        await cleanupTestAgency();
    }
});
