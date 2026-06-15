/**
 * P463 Integration Tests — Liaison Protocol AC-3 and AC-7
 *
 * AC-3: A dormant agency is reactivated to 'active' when a heartbeat arrives
 *       (the CASE `WHEN status = 'dormant' THEN 'active'` branch in liaisonHeartbeat).
 *
 * AC-7 (SUPERSEDED by P1438 AC-19, V3-C6): the old design made the prop_claim
 *       gateway reject a registered agency lacking an active liaison session. V3's
 *       liaison is a cold-wakeable AI session (no per-agency service opens a
 *       session), so that gate locked out the mandated model. The claim path now
 *       proceeds on durable gates (registry existence + lease availability);
 *       availability is revealed by a successful claim (emergent presence). The
 *       e2e test below asserts the rejection is GONE. The helper `hasActiveLiaisonSession`
 *       is retained for diagnostics only — it no longer gates claim.
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

/**
 * liaisonRegister() requires the roadmap.agency row to already exist (it no longer
 * auto-creates it). Seed a minimal active agency row so these integration tests can
 * exercise the liaison/claim paths.
 */
async function seedTestAgency(agency_id: string, display_name: string): Promise<void> {
	await query(
		`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
		 VALUES ($1, $2, 'test', 'bot', 'active')
		 ON CONFLICT (agency_id) DO UPDATE SET status = 'active'`,
		[agency_id, display_name],
	);
}

test("AC-3: dormant agency heartbeat → reactivated to active", async () => {
	const agency_id = `test-p463-ac3-${TS}`;
	await seedTestAgency(agency_id, "P463 AC-3 Test Agency");

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
	await endLiaisonSession(session_id, "test-cleanup" as any);
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [agency_id]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agency_id]);
});

test("AC-7 (diagnostic, post-P1438): hasActiveLiaisonSession reflects session lifecycle — no longer gates claim", async () => {
	const agency_id = `test-p463-ac7-${TS}`;
	await seedTestAgency(agency_id, "P463 AC-7 Test Agency");

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
	await endLiaisonSession(session_id, "test-shutdown" as any);

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

test("P1438 AC-19 e2e: claimProposal() does NOT reject a registered agency with no active session", async () => {
	const agency_id = `test-p463-ac7-e2e-${TS}`;
	await seedTestAgency(agency_id, "P463 AC-7 E2E Test Agency");

	const { session_id } = await liaisonRegister({
		agency_id,
		display_name: "P463 AC-7 E2E Test Agency",
		provider: "test",
		host_id: "bot",
	});
	// Close the session so hasActiveLiaisonSession returns false — the old AC-7
	// rejection condition. Under P1438 AC-19 this must NO LONGER block the claim.
	await endLiaisonSession(session_id, "normal");

	// Preconditions: registered, but cold (no open liaison session).
	assert.equal(await isRegisteredAgency(agency_id), true);
	assert.equal(await hasActiveLiaisonSession(agency_id), false);

	// Call the actual handler. Passing null for core is safe; claimProposal never
	// dereferences it on this path.
	const handlers = new PgProposalHandlers(null as any, "");
	const result = await handlers.claimProposal({ id: "463", agent: agency_id });

	const text = (result.content[0] as { type: string; text: string }).text;
	// AC-19 core: the session-prerequisite rejection is gone.
	assert.doesNotMatch(
		text,
		/no active liaison session/i,
		"P1438 AC-19: claim must NOT be rejected for lacking a liaison session",
	);
	assert.doesNotMatch(
		text,
		/there is no per-agency service to start|cold-wake it/i,
		"P1438 AC-19: the service-instruction error text must be gone",
	);
	// The claim proceeds on durable gates (lease availability). Whatever the lease
	// outcome (claimed / already-leased / not-found), it is a real claim-path
	// response, not the retired session gate.
	assert.match(
		text,
		/claim|lease|proposal|oversized|not found/i,
		"claim must reach the real claim/lease path once the session gate is removed",
	);

	// Cleanup
	await query(
		`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = 463
		   AND agent_identity = $1`,
		[agency_id],
	).catch(() => {});
	await query(`DELETE FROM roadmap.agency_liaison_session WHERE agency_id = $1`, [agency_id]);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agency_id]);
});

test.after(() => closePool());
