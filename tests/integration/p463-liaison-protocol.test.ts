/**
 * P463 Integration Tests — Liaison Protocol AC-3 and AC-7
 *
 * AC-3: A dormant agency is reactivated to 'active' when a heartbeat arrives
 *       (the CASE `WHEN status = 'dormant' THEN 'active'` branch in liaisonHeartbeat).
 *
 * AC-7: The prop_claim gateway rejects a registered agency that has no active
 *       liaison session (isRegisteredAgency=true but hasActiveLiaisonSession=false).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { query, closePool } from "../../src/infra/postgres/pool.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	endLiaisonSession,
	checkAndMarkDormant,
	isRegisteredAgency,
	hasActiveLiaisonSession,
	getAgencyStatus,
} from "../../src/infra/agency/liaison-service.ts";
import { PgProposalHandlers } from "../../src/apps/mcp-server/tools/proposals/pg-handlers.ts";

const TS = Date.now();

test("AC-3: dormant agency heartbeat → reactivated to active", async () => {
	const agency_id = `test-p463-ac3-${TS}`;

	const { session_id } = await liaisonRegister({
		agency_id,
		display_name: "P463 AC-3 Test Agency",
		provider: "test",
		host_id: "bot",
	});

	// Anchor a heartbeat so last_heartbeat_at is set
	await liaisonHeartbeat({ session_id, status: "active" });

	// Back-date heartbeat past 90s threshold to trigger dormancy
	await query(
		`UPDATE roadmap.agency
		 SET last_heartbeat_at = now() - interval '150 seconds'
		 WHERE agency_id = $1`,
		[agency_id],
	);

	// Dormancy watchdog should mark the agency dormant
	const marked = await checkAndMarkDormant();
	assert.ok(marked >= 1, "watchdog should have marked at least one agency dormant");

	const dormantStatus = await getAgencyStatus(agency_id);
	assert.equal(dormantStatus?.status, "dormant", "agency should be dormant before heartbeat");

	// Send a heartbeat — exercises the CASE `WHEN status = 'dormant' THEN 'active'` branch
	const result = await liaisonHeartbeat({ session_id, status: "active" });
	assert.equal(result.success, true, "heartbeat should succeed");
	assert.equal(
		result.agency_status,
		"active",
		"dormant agency must be reactivated to active by heartbeat (AC-3)",
	);

	// Confirm status in DB
	const activeStatus = await getAgencyStatus(agency_id);
	assert.equal(activeStatus?.status, "active", "DB status should reflect reactivation");

	// Cleanup
	await endLiaisonSession(session_id, "test-cleanup");
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [agency_id]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agency_id]);
});

test("AC-7: claim gateway helpers — registered agency without active session is rejected", async () => {
	const agency_id = `test-p463-ac7-${TS}`;

	const { session_id } = await liaisonRegister({
		agency_id,
		display_name: "P463 AC-7 Test Agency",
		provider: "test",
		host_id: "bot",
	});

	// Precondition: registered AND has active session → gateway would allow
	assert.equal(
		await isRegisteredAgency(agency_id),
		true,
		"newly registered agency must be in roadmap.agency",
	);
	assert.equal(
		await hasActiveLiaisonSession(agency_id),
		true,
		"newly registered agency must have an open session",
	);

	// Simulate liaison shutdown / crash — session is closed
	await endLiaisonSession(session_id, "test-shutdown");

	// After shutdown: registered but NO active session → gateway must reject
	assert.equal(
		await isRegisteredAgency(agency_id),
		true,
		"agency should remain registered after session ends",
	);
	assert.equal(
		await hasActiveLiaisonSession(agency_id),
		false,
		"hasActiveLiaisonSession must return false after session is closed (AC-7 rejection condition)",
	);

	// Cleanup
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [agency_id]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agency_id]);
});

test("AC-7 e2e: claimProposal() rejects registered agency with no active session", async () => {
	const agency_id = `test-p463-ac7-e2e-${TS}`;

	const { session_id } = await liaisonRegister({
		agency_id,
		display_name: "P463 AC-7 E2E Test Agency",
		provider: "test",
		host_id: "bot",
	});
	// Close the session so hasActiveLiaisonSession returns false
	await endLiaisonSession(session_id, "normal");

	// Preconditions
	assert.equal(await isRegisteredAgency(agency_id), true);
	assert.equal(await hasActiveLiaisonSession(agency_id), false);

	// Call the actual handler — AC-7 guard fires before any lease write.
	// Passing null for core is safe; claimProposal never dereferences it.
	const handlers = new PgProposalHandlers(null as any, "");
	const result = await handlers.claimProposal({ id: "463", agent: agency_id });

	const text = (result.content[0] as { type: string; text: string }).text;
	assert.match(
		text,
		/no active liaison session/i,
		"claimProposal must surface AC-7 rejection for agency with no session",
	);

	// Cleanup
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [agency_id]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agency_id]);
});

test.after(() => closePool());
