/**
 * P765 AC-5: Liveness recovery integration test.
 *
 * Scenario:
 *   1. Register a test agency + session.
 *   2. Simulate >300s silence by backdating last_heartbeat_at.
 *   3. Run liveness ticks: verify dormant → offline transitions.
 *   4. Send a heartbeat: verify offline → dormant (step 1 recovery).
 *   5. Send another heartbeat: verify dormant → active (step 2 recovery).
 *
 * Tests both roadmap.agency (liaison layer, 90s/5min thresholds)
 * and roadmap_workforce.provider_registry (resolver layer, 5/30 min thresholds).
 *
 * Pre-requisites:
 *   - Migration 130-p765-liveness-alerting must be applied (offline_alert_sent_at column).
 *   - Running Postgres with the roadmap + roadmap_workforce schemas.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { query } from "../../src/infra/postgres/pool.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	checkAndMarkDormant,
	checkAndMarkOffline,
} from "../../src/infra/agency/liaison-service.ts";
import {
	recordCheckIn,
	scanAndTransitionSilentAgencies,
} from "../../src/core/orchestration/resolvers/agency-resolver.ts";

const TS = Date.now();
const AGENCY_ID = `test/p765/liveness-${TS}`;

let sessionId: string;

async function getAgencyRow(): Promise<{ status: string; offline_alert_sent_at: Date | null }> {
	const { rows } = await query(
		`SELECT status, offline_alert_sent_at FROM roadmap.agency WHERE agency_id = $1`,
		[AGENCY_ID],
	);
	assert.ok(rows.length > 0, `Agency ${AGENCY_ID} not found`);
	return rows[0];
}

async function backdateHeartbeat(interval: string): Promise<void> {
	await query(
		`UPDATE roadmap.agency
		 SET last_heartbeat_at = now() - $1::interval
		 WHERE agency_id = $2`,
		[interval, AGENCY_ID],
	);
	// Also backdate provider_registry for the resolver layer
	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET last_seen_at = now() - $1::interval
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id AND ar.agent_identity = $2`,
		[interval, AGENCY_ID],
	);
}

async function cleanup(): Promise<void> {
	await query(
		`UPDATE roadmap.agency_liaison_session SET ended_at = now(), end_reason = 'normal'
		 WHERE agency_id = $1 AND ended_at IS NULL`,
		[AGENCY_ID],
	);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [AGENCY_ID]);
	// provider_registry cleaned via cascade from agent_registry
	await query(
		`DELETE FROM roadmap_workforce.provider_registry pr
		 USING roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id AND ar.agent_identity = $1`,
		[AGENCY_ID],
	);
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[AGENCY_ID],
	);
}

describe("P765 AC-5: liveness recovery state machine", () => {
	before(async () => {
		// Register the agency + open a liaison session
		const result = await liaisonRegister({
			agency_id: AGENCY_ID,
			display_name: `P765 Test Agency ${TS}`,
			provider: "test",
			host_id: "test-host",
		});
		sessionId = result.session_id;

		// Register in workforce tables so resolver layer is also covered
		await query(
			`INSERT INTO roadmap_workforce.agent_registry
			    (agent_identity, agent_type, trust_tier, status)
			 VALUES ($1, 'tool', 'known', 'active')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[AGENCY_ID],
		);
		// Enroll in any active project so provider_registry row exists
		const { rows: projects } = await query(
			`SELECT id FROM roadmap.project WHERE status = 'active' AND archived_at IS NULL LIMIT 1`,
		);
		if (projects.length > 0) {
			await query(
				`INSERT INTO roadmap_workforce.provider_registry
				    (agency_id, agency_identity, project_id, squad_name, status, max_in_flight)
				 SELECT ar.id, $1, $2, NULL, 'active', 4
				 FROM roadmap_workforce.agent_registry ar WHERE ar.agent_identity = $1
				 ON CONFLICT (agency_id, project_id, squad_name) DO NOTHING`,
				[AGENCY_ID, projects[0].id],
			);
		}
	});

	after(cleanup);

	it("starts active after registration", async () => {
		const row = await getAgencyRow();
		assert.equal(row.status, "active");
	});

	it("transitions active → dormant after 90s silence (roadmap.agency)", async () => {
		await backdateHeartbeat("100 seconds");
		const count = await checkAndMarkDormant();
		assert.ok(count >= 1, "Expected at least 1 agency to go dormant");
		const row = await getAgencyRow();
		assert.equal(row.status, "dormant");
	});

	it("transitions dormant → offline after 5min silence (roadmap.agency)", async () => {
		// Already backdated >90s; now also ensure >5min for checkAndMarkOffline
		await backdateHeartbeat("310 seconds");
		const count = await checkAndMarkOffline();
		assert.ok(count >= 1, "Expected at least 1 agency to go offline");
		const row = await getAgencyRow();
		assert.equal(row.status, "offline");
	});

	it("transitions offline → dormant on first heartbeat (AC-1 step 1)", async () => {
		const result = await liaisonHeartbeat({ session_id: sessionId });
		// roadmap.agency should be dormant now
		const row = await getAgencyRow();
		assert.equal(row.status, "dormant", "Agency should be dormant after first heartbeat from offline");
		// offline_alert_sent_at should be cleared
		assert.equal(row.offline_alert_sent_at, null, "offline_alert_sent_at should be cleared on recovery start");
		// liaison service result
		assert.equal(result.agency_status, "dormant");
	});

	it("transitions dormant → active on second heartbeat (AC-1 step 2)", async () => {
		const result = await liaisonHeartbeat({ session_id: sessionId });
		const row = await getAgencyRow();
		assert.equal(row.status, "active", "Agency should be active after second heartbeat");
		assert.equal(result.agency_status, "active");
		assert.equal(result.dispatchable, true);
	});

	it("provider_registry: offline → dormant → active via recordCheckIn (AC-1)", async () => {
		// Force the agency back to offline via backdating
		await backdateHeartbeat("35 minutes");
		await scanAndTransitionSilentAgencies(); // dormant then offline in provider_registry

		// Verify provider_registry is offline
		const { rows: prRows } = await query(
			`SELECT pr.status FROM roadmap_workforce.provider_registry pr
			 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			 WHERE ar.agent_identity = $1 LIMIT 1`,
			[AGENCY_ID],
		);
		if (prRows.length === 0) return; // no provider_registry row — skip resolver check

		assert.equal(prRows[0].status, "offline");

		// First check-in: offline → dormant
		await recordCheckIn(AGENCY_ID);
		const { rows: pr1 } = await query(
			`SELECT pr.status FROM roadmap_workforce.provider_registry pr
			 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			 WHERE ar.agent_identity = $1 LIMIT 1`,
			[AGENCY_ID],
		);
		assert.equal(pr1[0].status, "dormant", "provider_registry should be dormant after first check-in from offline");

		// Second check-in: dormant → active
		await recordCheckIn(AGENCY_ID);
		const { rows: pr2 } = await query(
			`SELECT pr.status FROM roadmap_workforce.provider_registry pr
			 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
			 WHERE ar.agent_identity = $1 LIMIT 1`,
			[AGENCY_ID],
		);
		assert.equal(pr2[0].status, "active", "provider_registry should be active after second check-in");
	});
});
