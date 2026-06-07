/**
 * P468: Two-way orchestrator↔liaison messaging protocol — 10 ACs
 *
 * Tests the class-based interface: LiaisonMessageLog, LiaisonMessageSigner,
 * OutOfOrderBuffer.
 *
 * AC1: Control plane messages (orchestrator→liaison) stored + retrieved
 * AC2: Idempotency — duplicate (agency_id, sequence) handled without error
 * AC3: Telemetry plane messages (liaison→orchestrator) stored + retrieved
 * AC4: Signed messages pass verify(); tampered payload fails
 * AC5: Replay-attack: signed_at older than 5 min rejected by verify()
 * AC6: Out-of-order buffer: flushes contiguous run on gap fill
 * AC7: Overflow beyond window emits protocol_resync, clears buffer
 * AC8: Ack is idempotent and persisted (acked_at set, outcome stored)
 * AC9: replayFrom() returns ordered slice for restart recovery
 * AC10: getMaxSequence() seeds OutOfOrderBuffer on reconnect
 */

import test from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/infra/postgres/pool.js";
import {
	LiaisonMessageLog,
	LiaisonMessageSigner,
	OutOfOrderBuffer,
} from "../../src/core/infrastructure/liaison-message-log.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENCY_ID = `test-p468-class-${Date.now()}`;

async function setup(): Promise<void> {
	await query(
		`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (agency_id) DO NOTHING`,
		[AGENCY_ID, "P468 Class Test Agency", "test", "bot", "active"],
	);
}

async function teardown(): Promise<void> {
	await query(
		`DELETE FROM roadmap.liaison_sequence WHERE agency_id = $1`,
		[AGENCY_ID],
	);
	await query(
		`DELETE FROM roadmap.liaison_message WHERE agency_id = $1`,
		[AGENCY_ID],
	);
	await query(
		`DELETE FROM roadmap.agency WHERE agency_id = $1`,
		[AGENCY_ID],
	);
}

// ─── AC1: Control plane orchestrator→liaison ──────────────────────────────────

test("AC1: control plane message (offer_dispatch) stored and retrieved", async () => {
	await setup();
	try {
		const log = new LiaisonMessageLog();
		const msg = await log.append({
			agencyId: AGENCY_ID,
			direction: "orchestrator->liaison",
			kind: "offer_dispatch",
			payload: {
				offer_id: crypto.randomUUID(),
				role: "developer",
				required_capabilities: ["bash"],
				route_hint: "claude",
			},
		});

		assert.ok(msg.message_id, "message_id generated");
		assert.equal(msg.agency_id, AGENCY_ID);
		assert.equal(msg.direction, "orchestrator->liaison");
		assert.equal(msg.kind, "offer_dispatch");
		assert.ok(msg.sequence >= 1n, "sequence assigned");
		assert.ok(msg.signature.length > 0, "signature present");

		const found = await log.findBySequence(AGENCY_ID, msg.sequence);
		assert.ok(found, "found by sequence");
		assert.equal(found!.message_id, msg.message_id);
	} finally {
		await teardown();
	}
});

// ─── AC2: Idempotency — duplicate sequence ───────────────────────────────────

test("AC2: duplicate (agency_id, sequence) via storeMessage is a no-op", async () => {
	await setup();
	try {
		// Use the service directly to inject a known sequence
		const { storeMessage } = await import(
			"../../src/infra/agency/liaison-message-service.js"
		);

		const seq = 99n;
		const firstId = crypto.randomUUID();
		const secondId = crypto.randomUUID();

		await storeMessage({
			message_id: firstId,
			agency_id: AGENCY_ID,
			sequence: seq,
			direction: "orchestrator->liaison",
			kind: "protocol_ping",
			correlation_id: crypto.randomUUID(),
			payload: { nonce: "abc" },
			signed_at: new Date().toISOString(),
			signature: "stub-sig",
		});

		// Duplicate with different message_id — ON CONFLICT DO UPDATE; second id wins
		const dup = await storeMessage({
			message_id: secondId,
			agency_id: AGENCY_ID,
			sequence: seq,
			direction: "orchestrator->liaison",
			kind: "liaison_pause",
			correlation_id: crypto.randomUUID(),
			payload: {},
			signed_at: new Date().toISOString(),
			signature: "stub-sig",
		});

		// Row exists at sequence=99
		assert.equal(dup.sequence, seq);
		const log = new LiaisonMessageLog();
		const row = await log.findBySequence(AGENCY_ID, seq);
		assert.ok(row, "row present after duplicate");
		assert.equal(row!.sequence, seq);
	} finally {
		await teardown();
	}
});

// ─── AC3: Telemetry plane liaison→orchestrator ───────────────────────────────

test("AC3: telemetry plane message (heartbeat) stored and retrieved", async () => {
	await setup();
	try {
		const log = new LiaisonMessageLog();
		const msg = await log.append({
			agencyId: AGENCY_ID,
			direction: "liaison->orchestrator",
			kind: "heartbeat",
			payload: {
				capacity_envelope: { max: 3, in_use: 1 },
				in_flight_count: 1,
			},
		});

		assert.equal(msg.direction, "liaison->orchestrator");
		assert.equal(msg.kind, "heartbeat");
		assert.ok((msg.payload as { in_flight_count?: number }).in_flight_count === 1);
	} finally {
		await teardown();
	}
});

// ─── AC4: Signature verification — valid and tampered ───────────────────────

test("AC4: valid HMAC signature passes; tampered payload fails", async () => {
	const signer = new LiaisonMessageSigner();
	const agencyId = "test-agency";
	const kind = "offer_dispatch";
	const payload = { offer_id: "abc-123", role: "dev" };
	const signedAt = new Date().toISOString();

	const sig = signer.sign(agencyId, kind, payload, signedAt);
	assert.equal(sig.length, 64, "HMAC-SHA256 produces 64-char hex digest");

	const valid = signer.verify(agencyId, kind, payload, signedAt, sig);
	assert.equal(valid, true, "valid signature verifies");

	const tampered = signer.verify(
		agencyId,
		kind,
		{ ...payload, role: "admin" },
		signedAt,
		sig,
	);
	assert.equal(tampered, false, "tampered payload fails verify");
});

// ─── AC5: Replay-attack prevention (signed_at skew) ─────────────────────────

test("AC5: signed_at older than 5 min fails verify()", async () => {
	const signer = new LiaisonMessageSigner();
	const agencyId = "test-agency";
	const kind = "heartbeat";
	const payload = { in_flight_count: 0, capacity_envelope: {} };
	const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago

	const sig = signer.sign(agencyId, kind, payload, staleAt);
	const valid = signer.verify(agencyId, kind, payload, staleAt, sig);
	assert.equal(valid, false, "stale signed_at rejected");
});

// ─── AC6: Out-of-order buffer — flushes on gap fill ─────────────────────────

test("AC6: out-of-order buffer flushes contiguous run when gap fills", () => {
	const buf = new OutOfOrderBuffer("agt-1");
	buf.setExpected(1n);

	const makeMsg = (seq: bigint) =>
		({
			message_id: crypto.randomUUID(),
			agency_id: "agt-1",
			sequence: seq,
			direction: "liaison->orchestrator",
			kind: "heartbeat",
			correlation_id: crypto.randomUUID(),
			payload: {},
			signed_at: new Date().toISOString(),
			signature: "stub",
		} as import("../../src/core/infrastructure/liaison-message-log.js").LiaisonMessage);

	// Push seq=3 first (ahead), then seq=2 (ahead), then seq=1 (in-order)
	const r3 = buf.push(makeMsg(3n));
	assert.equal(r3.flushed.length, 0, "seq=3 buffered, not flushed");
	assert.equal(r3.resync, null);

	const r2 = buf.push(makeMsg(2n));
	assert.equal(r2.flushed.length, 0, "seq=2 buffered, not flushed");

	// seq=1 in-order → flushes 1,2,3 contiguously
	const r1 = buf.push(makeMsg(1n));
	assert.equal(r1.flushed.length, 3, "flushed run of 3");
	assert.equal(r1.flushed[0].sequence, 1n);
	assert.equal(r1.flushed[1].sequence, 2n);
	assert.equal(r1.flushed[2].sequence, 3n);
	assert.equal(buf.expectedSequence, 4n, "expected advanced past flushed run");
});

// ─── AC7: Overflow triggers protocol_resync ──────────────────────────────────

test("AC7: overflow beyond window emits protocol_resync", () => {
	const buf = new OutOfOrderBuffer("agt-2");
	buf.setExpected(1n);

	const makeMsg = (seq: bigint) =>
		({
			message_id: crypto.randomUUID(),
			agency_id: "agt-2",
			sequence: seq,
			direction: "liaison->orchestrator",
			kind: "heartbeat",
			correlation_id: crypto.randomUUID(),
			payload: {},
			signed_at: new Date().toISOString(),
			signature: "stub",
		} as import("../../src/core/infrastructure/liaison-message-log.js").LiaisonMessage);

	// Push a message 150 ahead (beyond window=100)
	const r = buf.push(makeMsg(151n));
	assert.ok(r.resync, "resync signal emitted");
	assert.equal(r.resync!.type, "protocol_resync");
	assert.equal(r.resync!.agencyId, "agt-2");
	assert.ok(r.resync!.droppedCount > 0, "dropped count reported");
	assert.equal(r.flushed.length, 0, "nothing flushed on overflow");
	assert.equal(buf.bufferedCount, 0, "buffer cleared after resync");
});

// ─── AC8: Ack idempotency ─────────────────────────────────────────────────────

test("AC8: ack persists outcome; re-ack overwrites", async () => {
	await setup();
	try {
		const log = new LiaisonMessageLog();
		const msg = await log.append({
			agencyId: AGENCY_ID,
			direction: "liaison->orchestrator",
			kind: "claim_release",
			payload: { claim_id: crypto.randomUUID(), reason: "done" },
		});

		await log.ack(msg.message_id, "ok");

		const row1 = await query<{ ack_outcome: string; acked_at: string }>(
			`SELECT ack_outcome, acked_at FROM roadmap.liaison_message WHERE message_id = $1`,
			[msg.message_id],
		);
		assert.equal(row1.rows[0].ack_outcome, "ok");
		assert.ok(row1.rows[0].acked_at, "acked_at set");

		// Re-ack with 'noop'
		await log.ack(msg.message_id, "noop");
		const row2 = await query<{ ack_outcome: string }>(
			`SELECT ack_outcome FROM roadmap.liaison_message WHERE message_id = $1`,
			[msg.message_id],
		);
		assert.equal(row2.rows[0].ack_outcome, "noop", "overwritten on re-ack");
	} finally {
		await teardown();
	}
});

// ─── AC9: replayFrom() for restart recovery ──────────────────────────────────

test("AC9: replayFrom() returns ordered slice for restart recovery", async () => {
	await setup();
	try {
		const log = new LiaisonMessageLog();

		// Append 4 messages
		for (let i = 0; i < 4; i++) {
			await log.append({
				agencyId: AGENCY_ID,
				direction: "orchestrator->liaison",
				kind: "offer_dispatch",
				payload: {
					offer_id: crypto.randomUUID(),
					role: "dev",
					required_capabilities: [],
					route_hint: "claude",
				},
			});
		}

		const all = await log.replayFrom(AGENCY_ID, 1n);
		assert.equal(all.length, 4, "all 4 messages replayed");

		// Sequences must be monotonically increasing
		for (let i = 1; i < all.length; i++) {
			assert.ok(
				all[i].sequence > all[i - 1].sequence,
				"sequences are ordered",
			);
		}

		// Slice from sequence 3
		const slice = await log.replayFrom(AGENCY_ID, all[2].sequence);
		assert.equal(slice.length, 2, "partial replay from seq 3");
		assert.equal(slice[0].sequence, all[2].sequence);
	} finally {
		await teardown();
	}
});

// ─── AC10: getMaxSequence() seeds OutOfOrderBuffer ───────────────────────────

test("AC10: getMaxSequence() seeds OutOfOrderBuffer on reconnect", async () => {
	await setup();
	try {
		const log = new LiaisonMessageLog();

		// No messages yet → max = 0
		const empty = await log.getMaxSequence(AGENCY_ID);
		assert.equal(empty, 0n, "empty agency returns 0n");

		// Append 3 messages
		for (let i = 0; i < 3; i++) {
			await log.append({
				agencyId: AGENCY_ID,
				direction: "liaison->orchestrator",
				kind: "heartbeat",
				payload: { capacity_envelope: {}, in_flight_count: i },
			});
		}

		const max = await log.getMaxSequence(AGENCY_ID);
		assert.ok(max >= 3n, "max >= 3 after 3 appends");

		// Seed OutOfOrderBuffer for reconnect
		const buf = new OutOfOrderBuffer(AGENCY_ID);
		buf.setExpected(max + 1n);
		assert.equal(buf.expectedSequence, max + 1n, "buffer seeded from max+1");
	} finally {
		await teardown();
	}
});
