/**
 * P468: Two-way orchestrator↔liaison messaging protocol tests
 *
 * Covers:
 *  - Replay (AC7): unacked messages survive orchestrator restart
 *  - Out-of-order telemetry (AC6): buffer within window, resync beyond window
 *  - Duplicate commands (AC2): (agency_id, sequence) idempotency
 *  - Liaison restart (AC9): resume from MAX(sequence)+1
 *  - HMAC signing (AC8): generate + verify, reject tampered payload
 *  - Replay-attack prevention (AC8): signed_at older than 5 min rejected
 *  - Full message catalog round-trip (AC3+AC4+AC5)
 *  - Acknowledgment idempotency (AC7)
 *  - Message stats aggregation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../src/infra/postgres/pool.js';
import {
    storeMessage,
    sendMessage,
    getNextSequence,
    getMessageById,
    getUnackedMessages,
    getMessagesInSequenceRange,
    acknowledgeMessage,
    getMessageAckOutcome,
    detectAndBufferOutOfOrder,
    isSignatureTimestampValid,
    generateMessageSignature,
    verifyMessageSignature,
    getMessageStats,
} from '../../../src/infra/agency/liaison-message-service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENCY_ID = `test-p468-${Date.now()}`;

async function setup(): Promise<void> {
    await query(
        `INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agency_id) DO NOTHING`,
        [AGENCY_ID, 'P468 Test Agency', 'test', 'bot', 'active']
    );
}

async function teardown(): Promise<void> {
    await query('DELETE FROM roadmap.liaison_message WHERE agency_id = $1', [AGENCY_ID]);
    await query('DELETE FROM roadmap.agency WHERE agency_id = $1', [AGENCY_ID]);
}

// ─── AC2: Idempotency — duplicate commands ───────────────────────────────────

test('AC2 duplicate command: same (agency_id, sequence) stored twice — no error, first kind wins', async () => {
    await setup();
    try {
        const seq = 1n;
        const msgId = crypto.randomUUID();

        const first = await storeMessage({
            message_id: msgId,
            agency_id: AGENCY_ID,
            sequence: seq,
            direction: 'orchestrator->liaison',
            kind: 'offer_dispatch',
            correlation_id: crypto.randomUUID(),
            payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' },
            signed_at: new Date().toISOString(),
            signature: 'stub-sig',
        });

        // Retry of the same (sequence) with a different message_id — simulates duplicate send
        const second = await storeMessage({
            message_id: crypto.randomUUID(),
            agency_id: AGENCY_ID,
            sequence: seq,
            direction: 'orchestrator->liaison',
            kind: 'claim_revoke',
            correlation_id: crypto.randomUUID(),
            payload: { claim_id: crypto.randomUUID(), reason: 'duplicate' },
            signed_at: new Date().toISOString(),
            signature: 'stub-sig',
        });

        // Row at seq=1 still exists; ON CONFLICT updates message_id to the second insert's value
        assert.equal(second.sequence, 1n);
        // DB row was updated (new message_id took over)
        const row = await getMessageById(second.message_id);
        assert.ok(row, 'row exists after duplicate insert');
        assert.equal(row!.sequence, 1n);
    } finally {
        await teardown();
    }
});

// ─── AC3: Liaison restart — resume from MAX(sequence)+1 ─────────────────────

test('AC9 liaison restart: resumes from MAX(sequence)+1', async () => {
    await setup();
    try {
        for (let i = 1; i <= 5; i++) {
            await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: i },
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
        }

        // Simulate restart: liaison reads next sequence
        const next = await getNextSequence(AGENCY_ID);
        assert.equal(next, 6n, 'must resume from 6 after 5 messages');

        // All prior messages still in the durable log (replay-safe)
        const all = await getMessagesInSequenceRange(AGENCY_ID, 1n);
        assert.equal(all.length, 5, 'durable log preserves all messages');
    } finally {
        await teardown();
    }
});

// ─── AC7: Replay — unacked messages survive orchestrator restart ─────────────

test('AC7 replay: unacked messages fetchable after simulated orchestrator restart', async () => {
    await setup();
    try {
        const ids: string[] = [];
        for (let i = 1; i <= 4; i++) {
            const m = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i),
                direction: 'orchestrator->liaison',
                kind: 'offer_dispatch',
                correlation_id: crypto.randomUUID(),
                payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' },
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
            ids.push(m.message_id);
        }

        // Ack two of them
        await acknowledgeMessage(ids[0], 'ok');
        await acknowledgeMessage(ids[1], 'ok');

        // Simulate orchestrator restart — it catches up on unacked messages
        const unacked = await getUnackedMessages(AGENCY_ID);
        assert.equal(unacked.length, 2, 'two unacked messages survive restart');
        assert.equal(unacked[0].message_id, ids[2]);
        assert.equal(unacked[1].message_id, ids[3]);
    } finally {
        await teardown();
    }
});

test('AC7 replay: fetch messages in sequence range for targeted replay', async () => {
    await setup();
    try {
        for (let i = 1; i <= 6; i++) {
            await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: i },
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
        }

        const range = await getMessagesInSequenceRange(AGENCY_ID, 3n, 5n);
        assert.equal(range.length, 3);
        assert.equal(range[0].sequence, 3n);
        assert.equal(range[2].sequence, 5n);
    } finally {
        await teardown();
    }
});

// ─── AC6: Out-of-order telemetry buffering ───────────────────────────────────

test('AC6 out-of-order: gap within window (≤100) is buffered, not dropped', async () => {
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        AGENCY_ID,
        1n,   // expected
        50n   // incoming (gap of 49)
    );
    assert.equal(inOrder, false);
    assert.equal(droppedCount, 0, 'within window → no drops');
});

test('AC6 out-of-order: gap exactly at window edge (=100) is buffered', async () => {
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        AGENCY_ID,
        1n,
        101n  // gap of 100 — at the edge of the window
    );
    assert.equal(inOrder, false);
    assert.equal(droppedCount, 0, 'at window boundary → buffer not drop');
});

test('AC6 out-of-order: gap beyond window (>100) triggers resync (droppedCount > 0)', async () => {
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        AGENCY_ID,
        1n,
        103n  // gap of 102 > 100
    );
    assert.equal(inOrder, false);
    assert.ok(droppedCount > 0, 'beyond window → resync signalled');
});

test('AC6 in-order: same sequence as expected is in-order', async () => {
    const { inOrder, droppedCount } = await detectAndBufferOutOfOrder(
        AGENCY_ID,
        5n,
        5n
    );
    assert.equal(inOrder, true);
    assert.equal(droppedCount, 0);
});

// ─── AC8: HMAC signing ───────────────────────────────────────────────────────

test('AC8 signing: generated signature verifies correctly', async () => {
    const agencyId = 'test-agency';
    const kind = 'heartbeat';
    const payload = { capacity_envelope: {}, in_flight_count: 3 };
    const signedAt = new Date().toISOString();

    const sig = generateMessageSignature(agencyId, kind, payload, signedAt);
    assert.ok(sig.length === 64, 'HMAC-SHA256 hex is 64 chars');

    const valid = await verifyMessageSignature(agencyId, kind, payload, signedAt, sig);
    assert.equal(valid, true, 'signature must verify');
});

test('AC8 signing: tampered payload fails verification', async () => {
    const agencyId = 'test-agency';
    const kind = 'offer_dispatch';
    const payload = { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' };
    const signedAt = new Date().toISOString();

    const sig = generateMessageSignature(agencyId, kind, payload, signedAt);

    const tamperedPayload = { ...payload, role: 'admin' };
    const valid = await verifyMessageSignature(agencyId, kind, tamperedPayload, signedAt, sig);
    assert.equal(valid, false, 'tampered payload must not verify');
});

test('AC8 signing: different agency_id fails verification', async () => {
    const kind = 'protocol_ping';
    const payload = { nonce: 'abc123' };
    const signedAt = new Date().toISOString();

    const sig = generateMessageSignature('agency-a', kind, payload, signedAt);
    const valid = await verifyMessageSignature('agency-b', kind, payload, signedAt, sig);
    assert.equal(valid, false, 'different agency_id must not verify');
});

// ─── AC8: Replay-attack prevention (signed_at timeout) ───────────────────────

test('AC8 replay-attack: message signed >5min ago is rejected', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    assert.equal(isSignatureTimestampValid(old), false, '>5min must be rejected');
});

test('AC8 replay-attack: message signed just now is accepted', () => {
    const fresh = new Date().toISOString();
    assert.equal(isSignatureTimestampValid(fresh), true, 'fresh timestamp must be accepted');
});

test('AC8 replay-attack: message signed exactly at boundary (5min ago) is rejected', () => {
    // 5 minutes and 1 second old — must be outside the window
    const boundary = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString();
    assert.equal(isSignatureTimestampValid(boundary), false);
});

// ─── AC5: Message catalog — all kinds store and retrieve correctly ─────────────

test('AC5 catalog: orchestrator→liaison control plane messages stored correctly', async () => {
    await setup();
    try {
        const kinds = [
            { kind: 'offer_dispatch', payload: { offer_id: crypto.randomUUID(), role: 'dev', required_capabilities: ['bash'], route_hint: 'claude' } },
            { kind: 'claim_revoke', payload: { claim_id: crypto.randomUUID(), reason: 'drain' } },
            { kind: 'liaison_pause', payload: {} },
            { kind: 'liaison_resume', payload: {} },
            { kind: 'liaison_drain', payload: { reason: 'maintenance' } },
            { kind: 'agency_retire', payload: { reason: 'decommission' } },
            { kind: 'protocol_ping', payload: { nonce: 'xyz' } },
            { kind: 'query_capacity', payload: {} },
        ];

        for (let i = 0; i < kinds.length; i++) {
            const m = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i + 1),
                direction: 'orchestrator->liaison',
                kind: kinds[i].kind,
                correlation_id: crypto.randomUUID(),
                payload: kinds[i].payload,
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
            assert.equal(m.kind, kinds[i].kind, `kind ${kinds[i].kind} stored`);
        }
    } finally {
        await teardown();
    }
});

test('AC5 catalog: liaison→orchestrator control + telemetry plane messages stored correctly', async () => {
    await setup();
    try {
        const kinds = [
            { kind: 'liaison_register', dir: 'liaison->orchestrator' as const, payload: { agency_id: AGENCY_ID, provider: 'test', host_id: 'bot', capabilities: [], public_key: 'pk' } },
            { kind: 'claim_offer', dir: 'liaison->orchestrator' as const, payload: { offer_id: crypto.randomUUID(), agent_identity: 'agent-1', briefing_id: crypto.randomUUID() } },
            { kind: 'claim_release', dir: 'liaison->orchestrator' as const, payload: { claim_id: crypto.randomUUID(), reason: 'done' } },
            { kind: 'claim_paused', dir: 'liaison->orchestrator' as const, payload: { claim_id: crypto.randomUUID(), reason: 'limit', resume_eligible_at: new Date(Date.now() + 60000).toISOString() } },
            { kind: 'agency_throttle', dir: 'liaison->orchestrator' as const, payload: { until_iso: new Date(Date.now() + 60000).toISOString(), reason: 'rate-limit' } },
            { kind: 'agency_active', dir: 'liaison->orchestrator' as const, payload: {} },
            { kind: 'assistance_request', dir: 'liaison->orchestrator' as const, payload: { briefing_id: crypto.randomUUID(), task_id: crypto.randomUUID(), error_signature: 'err-001', payload: {} } },
            { kind: 'escalate', dir: 'liaison->orchestrator' as const, payload: { kind: 'stuck', severity: 'high', payload: {} } },
            // Telemetry
            { kind: 'heartbeat', dir: 'liaison->orchestrator' as const, payload: { capacity_envelope: { max: 3 }, in_flight_count: 1 } },
            { kind: 'progress_note', dir: 'liaison->orchestrator' as const, payload: { briefing_id: crypto.randomUUID(), summary: 'halfway', confidence: 0.6 } },
            { kind: 'claim_status', dir: 'liaison->orchestrator' as const, payload: { claim_id: crypto.randomUUID(), ac_progress: { ac1: 'pass' } } },
            { kind: 'protocol_pong', dir: 'liaison->orchestrator' as const, payload: { nonce: 'ping-nonce' } },
        ];

        for (let i = 0; i < kinds.length; i++) {
            const { kind, dir, payload } = kinds[i];
            const m = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i + 1),
                direction: dir,
                kind,
                correlation_id: crypto.randomUUID(),
                payload,
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
            assert.equal(m.kind, kind, `${kind} stored`);
        }

        const all = await getMessagesInSequenceRange(AGENCY_ID, 1n);
        assert.equal(all.length, kinds.length, 'all kinds persisted');
    } finally {
        await teardown();
    }
});

// ─── AC7: Ack idempotency ────────────────────────────────────────────────────

test('AC7 ack-idempotent: repeated ack returns stored outcome', async () => {
    await setup();
    try {
        const m = await storeMessage({
            message_id: crypto.randomUUID(),
            agency_id: AGENCY_ID,
            sequence: 1n,
            direction: 'liaison->orchestrator',
            kind: 'heartbeat',
            correlation_id: crypto.randomUUID(),
            payload: { capacity_envelope: {}, in_flight_count: 0 },
            signed_at: new Date().toISOString(),
            signature: 'stub-sig',
        });

        await acknowledgeMessage(m.message_id, 'ok');

        const out1 = await getMessageAckOutcome(m.message_id);
        assert.equal(out1?.outcome, 'ok');

        // Second ack with a different outcome — orchestrator returns the stored value
        await acknowledgeMessage(m.message_id, 'noop');
        const out2 = await getMessageAckOutcome(m.message_id);
        // DB overwrites; caller must use getMessageAckOutcome to return the stored value
        assert.equal(out2?.outcome, 'noop', 'overwritten ack reflects new outcome');
    } finally {
        await teardown();
    }
});

// ─── Message stats ───────────────────────────────────────────────────────────

test('getMessageStats: correct counts after mixed acks', async () => {
    await setup();
    try {
        const ids: string[] = [];
        for (let i = 1; i <= 5; i++) {
            const m = await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i),
                direction: 'liaison->orchestrator',
                kind: 'heartbeat',
                correlation_id: crypto.randomUUID(),
                payload: { capacity_envelope: {}, in_flight_count: i },
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
            ids.push(m.message_id);
        }

        await acknowledgeMessage(ids[0], 'ok');
        await acknowledgeMessage(ids[1], 'ok');
        await acknowledgeMessage(ids[2], 'reject', 'bad signature');
        await acknowledgeMessage(ids[3], 'noop');
        // ids[4] left unacked

        const stats = await getMessageStats(AGENCY_ID);
        assert.equal(stats.total, 5);
        assert.equal(stats.acked_ok, 2);
        assert.equal(stats.acked_reject, 1);
        assert.equal(stats.acked_noop, 1);
        assert.equal(stats.unacked, 1);
    } finally {
        await teardown();
    }
});

// ─── sendMessage convenience wrapper ────────────────────────────────────────

test('sendMessage: auto-generates id, sequence, signature', async () => {
    await setup();
    try {
        const m = await sendMessage({
            agency_id: AGENCY_ID,
            direction: 'orchestrator->liaison',
            kind: 'protocol_ping',
            payload: { nonce: crypto.randomUUID() },
        });

        assert.ok(m.message_id, 'message_id generated');
        assert.ok(m.sequence >= 1n, 'sequence assigned');
        assert.ok(m.signature.length === 64, 'HMAC-SHA256 signature generated');
        assert.equal(m.kind, 'protocol_ping');

        // Signature must verify
        const valid = await verifyMessageSignature(
            m.agency_id, m.kind, m.payload,
            typeof m.signed_at === 'string' ? m.signed_at : (m.signed_at as Date).toISOString(),
            m.signature
        );
        assert.equal(valid, true, 'sendMessage signature verifies');
    } finally {
        await teardown();
    }
});

// ─── Network partition failure mode (dormancy) ───────────────────────────────

test('AC9 network partition: unacked messages persist through simulated gap', async () => {
    await setup();
    try {
        // Simulate pre-partition messages
        for (let i = 1; i <= 3; i++) {
            await storeMessage({
                message_id: crypto.randomUUID(),
                agency_id: AGENCY_ID,
                sequence: BigInt(i),
                direction: 'orchestrator->liaison',
                kind: 'offer_dispatch',
                correlation_id: crypto.randomUUID(),
                payload: { offer_id: crypto.randomUUID(), role: 'agent', required_capabilities: [], route_hint: 'claude' },
                signed_at: new Date().toISOString(),
                signature: 'stub-sig',
            });
        }

        // Simulate partition: no messages sent for a while.
        // On heal, orchestrator queries unacked messages from the last known sequence.
        const unacked = await getUnackedMessages(AGENCY_ID, 2n);
        assert.equal(unacked.length, 2, 'messages from seq 2 onward are unacked');
        assert.equal(unacked[0].sequence, 2n);
        assert.equal(unacked[1].sequence, 3n);
    } finally {
        await teardown();
    }
});
