/**
 * Integration tests for liaison-protocol wiring (P464/P467/P468).
 *
 * Tests:
 * 1. Agency registration → liaison session created
 * 2. Heartbeat updates last_heartbeat_at
 * 3. Orchestrator posts work offer → squad_dispatch + liaison_message
 * 4. Message acknowledgment
 * 5. Shutdown → session ended
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { query, closePool } from "../../src/infra/postgres/pool.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	getAgencyStatus,
	listDispatchableAgencies,
	endLiaisonSession,
	checkAndMarkDormant,
} from "../../src/infra/agency/liaison-service.ts";
import {
	storeMessage,
	getUnackedMessages,
	acknowledgeMessage,
	getMessageStats,
} from "../../src/infra/agency/liaison-message-service.ts";

const TS = Date.now();

test("Liaison Registration → Agency enters DB with session", async () => {
	const { session_id, agency_id } = await liaisonRegister({
		agency_id: `copilot/test-agency-1-${TS}`,
		display_name: "test-agency-1",
		provider: "copilot",
		host_id: "bot",
		capabilities: ["test", "copilot"],
	});

	assert.ok(session_id, "session_id should be returned");
	assert.ok(agency_id, "agency_id should be returned");
	assert.match(
		agency_id,
		/^copilot\//,
		"agency_id should be prefixed by provider",
	);

	// Verify in DB via getAgencyStatus (does not expose provider)
	const status = await getAgencyStatus(agency_id);
	assert.equal(status.agency_id, agency_id);
	assert.equal(status.display_name, "test-agency-1");
	assert.equal(status.status, "active");

	// provider is not in getAgencyStatus() return type — verify via direct query
	const { rows: [agencyRow] } = await query(
		`SELECT provider FROM roadmap.agency WHERE agency_id = $1`,
		[agency_id],
	);
	assert.equal(agencyRow.provider, "copilot");

	// Verify session
	const { rows: sessions } = await query(
		`SELECT session_id, ended_at FROM roadmap.agency_liaison_session WHERE session_id = $1`,
		[session_id],
	);
	assert.equal(sessions.length, 1, "session should exist");
	assert.equal(sessions[0].ended_at, null, "session should not be ended");
});

test("Heartbeat updates last_heartbeat_at", async (t) => {
	const { session_id, agency_id } = await liaisonRegister({
		agency_id: `copilot/test-heartbeat-${TS}`,
		display_name: `test-agency-heartbeat-${TS}`,
		provider: "copilot",
		host_id: "bot",
	});

	// last_heartbeat_at is not in getAgencyStatus() return type — query directly
	const { rows: [beforeRow] } = await query(
		`SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
		[agency_id],
	);
	assert.ok(!beforeRow.last_heartbeat_at, "last_heartbeat_at should be null initially");

	await new Promise((resolve) => setTimeout(resolve, 100));

	const result = await liaisonHeartbeat({
		session_id,
		status: "active",
	});

	assert.equal(result.success, true);

	const { rows: [afterRow] } = await query(
		`SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
		[agency_id],
	);
	assert.ok(afterRow.last_heartbeat_at, "last_heartbeat_at should be set after heartbeat");

	const after = await getAgencyStatus(agency_id);
	assert.ok(after.silence_seconds <= 1, "silence_seconds should be ~0");
});

test("ListDispatchableAgencies filters by silence threshold", async (t) => {
	// Register fresh agency
	const { agency_id: fresh_id } = await liaisonRegister({
		agency_id: `copilot/fresh-agency-${TS}`,
		display_name: "fresh-agency",
		provider: "copilot",
		host_id: "bot",
	});

	// Send heartbeat to make it fresh
	const { rows: sessions } = await query(
		`SELECT session_id FROM roadmap.agency_liaison_session WHERE agency_id = $1 ORDER BY started_at DESC LIMIT 1`,
		[fresh_id],
	);
	const session_id = sessions[0].session_id;

	await liaisonHeartbeat({
		session_id,
		status: "active",
	});

	// listDispatchableAgencies() takes no arguments — function filters by dispatchable=true
	const list = await listDispatchableAgencies();
	const hasFresh = list.some((a) => a.agency_id === fresh_id);
	assert.ok(hasFresh, "fresh agency should be in dispatchable list");
});

test("Liaison Message: storeMessage → getUnackedMessages → acknowledgeMessage", async (t) => {
	const { agency_id } = await liaisonRegister({
		agency_id: `copilot/test-msg-${TS}`,
		display_name: `test-agency-msg-${TS}`,
		provider: "copilot",
		host_id: "bot",
	});

	// Store a message
	const { message_id, sequence } = await storeMessage({
		agency_id,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		payload: {
			dispatch_id: "test-dispatch-1",
			proposal_id: 999,
			task: "Test task",
		},
	});

	assert.ok(message_id, "message_id should be returned");
	assert.equal(sequence, 0, "first message should have sequence 0");

	// Retrieve unacked
	const unacked = await getUnackedMessages(agency_id);
	assert.equal(unacked.length, 1, "should have 1 unacked message");
	assert.equal(unacked[0].message_id, message_id);
	assert.equal(unacked[0].kind, "offer_dispatch");
	assert.equal(unacked[0].payload.dispatch_id, "test-dispatch-1");

	// Acknowledge
	await acknowledgeMessage(message_id, "ok");

	const unackedAfter = await getUnackedMessages(agency_id);
	assert.equal(unackedAfter.length, 0, "should have 0 unacked after ack");

	// Check stats
	const stats = await getMessageStats(agency_id);
	assert.equal(stats.total, 1);
	assert.equal(stats.acked_ok, 1);
});

test("Multiple messages maintain sequence order", async (t) => {
	const { agency_id } = await liaisonRegister({
		agency_id: `copilot/test-seq-${TS}`,
		display_name: `test-agency-seq-${TS}`,
		provider: "copilot",
		host_id: "bot",
	});

	// Store 3 messages
	const msg1 = await storeMessage({
		agency_id,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		payload: { dispatch_id: "d1" },
	});

	const msg2 = await storeMessage({
		agency_id,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		payload: { dispatch_id: "d2" },
	});

	const msg3 = await storeMessage({
		agency_id,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		payload: { dispatch_id: "d3" },
	});

	assert.equal(msg1.sequence, 0);
	assert.equal(msg2.sequence, 1);
	assert.equal(msg3.sequence, 2);

	// Retrieve in order
	const unacked = await getUnackedMessages(agency_id, 10);
	assert.equal(unacked.length, 3);
	assert.equal(Number(unacked[0].sequence), 0);
	assert.equal(Number(unacked[1].sequence), 1);
	assert.equal(Number(unacked[2].sequence), 2);
});

test("Shutdown: endLiaisonSession marks session.ended_at", async (t) => {
	const { session_id, agency_id } = await liaisonRegister({
		agency_id: `copilot/test-shutdown-${TS}`,
		display_name: "test-agency-shutdown",
		provider: "copilot",
		host_id: "bot",
	});

	// Verify session is open
	let { rows: before } = await query(
		`SELECT ended_at FROM roadmap.agency_liaison_session WHERE session_id = $1`,
		[session_id],
	);
	assert.equal(before[0].ended_at, null);

	// End session
	await endLiaisonSession(session_id, "normal");

	// Verify session is closed
	const { rows: after } = await query(
		`SELECT ended_at, end_reason FROM roadmap.agency_liaison_session WHERE session_id = $1`,
		[session_id],
	);
	assert.ok(after[0].ended_at, "ended_at should be set");
	assert.equal(after[0].end_reason, "normal");

	// Verify heartbeat throws on closed session
	await assert.rejects(
		() => liaisonHeartbeat({ session_id, status: "active" }),
		/not found|already ended/i,
		"heartbeat should throw on closed session",
	);
});

test("Dormancy detection: checkAndMarkDormant", async (t) => {
	const { session_id, agency_id } = await liaisonRegister({
		agency_id: `copilot/test-dormant-${TS}`,
		display_name: "test-agency-dormant",
		provider: "copilot",
		host_id: "bot",
	});

	// Send heartbeat so it has a timestamp
	await liaisonHeartbeat({ session_id, status: "active" });

	// Manually set old timestamp for testing
	await query(
		`UPDATE roadmap.agency SET last_heartbeat_at = now() - interval '150 seconds' WHERE agency_id = $1`,
		[agency_id],
	);

	// checkAndMarkDormant() takes no arguments
	const marked = await checkAndMarkDormant();
	assert.ok(marked >= 1, "should mark at least 1 agency as dormant");

	// Verify status changed
	const status = await getAgencyStatus(agency_id);
	assert.equal(status.status, "dormant");
});

test("Integration: Register → Heartbeat → Message → Acknowledge → Shutdown", async (t) => {
	// Register
	const { session_id, agency_id } = await liaisonRegister({
		agency_id: `copilot/full-integration-${TS}`,
		display_name: "test-full-integration",
		provider: "copilot",
		host_id: "bot",
		capabilities: ["integration-test"],
	});

	// Heartbeat
	const hb = await liaisonHeartbeat({ session_id, status: "active" });
	assert.ok(hb.success);

	// Store message (simulating orchestrator dispatch)
	const { message_id } = await storeMessage({
		agency_id,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		payload: {
			dispatch_id: "integration-test-1",
			proposal_id: 123,
			task: "Test integration task",
		},
	});

	// Get unacked
	const unacked = await getUnackedMessages(agency_id);
	assert.equal(unacked.length, 1);

	// Acknowledge
	await acknowledgeMessage(message_id, "ok");

	const unackedAfter = await getUnackedMessages(agency_id);
	assert.equal(unackedAfter.length, 0);

	// Shutdown
	await endLiaisonSession(session_id, "normal");

	const { rows: sessions } = await query(
		`SELECT ended_at FROM roadmap.agency_liaison_session WHERE session_id = $1`,
		[session_id],
	);
	assert.ok(sessions[0].ended_at);
});

// Cleanup
test.after(() => {
	return closePool();
});
