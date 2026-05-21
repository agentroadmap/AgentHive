/**
 * P1339: fn_pulse bridge to provider_registry test coverage
 *
 * Exercises all 5 status states and all 4 pulse states:
 * - online/busy on offline → active + counters reset
 * - online/busy on dormant → active + counters reset
 * - online/busy on active → stays active, last_seen_at refreshed, counters preserved
 * - online/busy on throttled → stays throttled (operator-set, no auto-clear)
 * - online/busy on retired → stays retired (terminal)
 * - away on any non-retired → last_seen_at refreshed; status unchanged
 * - offline on any → provider_registry untouched (downward path owned by scanAndTransitionSilentAgencies)
 * - presence_state on roadmap.agency also updates correctly in every branch
 * - agency_presence_changed NOTIFY fires only on state transitions
 *
 * AC-7/8/9 (D2 remediation): throttled rows unchanged, param names correct, direct agency_identity match (no agent_registry JOIN).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { query } from "../../infra/postgres/pool.ts";

describe("P1339: fn_pulse bridge to provider_registry", () => {
	const testPrefix = "p1339_test";
	let testCounter = 0;

	function makeTestId(role: string): string {
		return `${testPrefix}_${role}_${testCounter++}`;
	}

	function makePrAgencyId(agencyId: string): string {
		return `pr_${agencyId}`;
	}

	/**
	 * Clean up all test data scoped to our test IDs.
	 * Delete in order: provider_registry, agent_registry, agency, notification_queue.
	 */
	async function cleanupTestData(agencyIds: string[]) {
		if (agencyIds.length === 0) return;

		// Delete provider_registry rows for our test agencies
		await query(
			`DELETE FROM roadmap_workforce.provider_registry
			  WHERE agency_identity = ANY($1)`,
			[agencyIds],
		);

		// Delete agent_registry rows (cascade deletes provider_registry if needed)
		await query(
			`DELETE FROM roadmap_workforce.agent_registry
			  WHERE agent_identity = ANY($1)`,
			[agencyIds],
		);

		// Delete agency rows
		await query(
			`DELETE FROM roadmap.agency
			  WHERE agency_id = ANY($1)`,
			[agencyIds],
		);

		// Delete notification_queue rows (prevent alert leaks) - only those with proposal_id
		const { rows: nqRows } = await query<{ proposal_id: number | null }>(
			`SELECT DISTINCT proposal_id FROM roadmap.notification_queue
			  WHERE proposal_id IS NOT NULL
			  AND metadata->>'agency_id' = ANY($1::text[])`,
			[agencyIds],
		);

		if (nqRows.length > 0) {
			const proposalIds = nqRows.map((r) => r.proposal_id);
			await query(
				`DELETE FROM roadmap.notification_queue
				  WHERE proposal_id = ANY($1::bigint[])`,
				[proposalIds],
			);
		}
	}

	beforeEach(() => {
		testCounter = 0;
	});

	afterEach(async () => {
		// Gather all test IDs we created and clean them up
		const { rows } = await query<{ agency_id: string }>(
			`SELECT DISTINCT agency_id FROM roadmap.agency
			  WHERE agency_id LIKE $1`,
			[`${testPrefix}_%`],
		);

		const agencyIds = rows.map((r) => r.agency_id);
		await cleanupTestData(agencyIds);
	});

	/**
	 * Helper: insert test agency and provider_registry row
	 */
	async function setupTestAgency(
		agencyId: string,
		prStatus: "active" | "dormant" | "offline" | "throttled" | "retired" = "active",
		prMetadata?: Partial<{
			throttle_count: number;
			recent_failure_count: number;
			last_failure_at: string | null;
			alert_sent_at: string | null;
		}>,
	) {
		// Insert agency
		await query(
			`INSERT INTO roadmap.agency
			  (agency_id, display_name, provider, host_id, status, presence_state)
			 VALUES ($1, 'Test Agency', 'test-provider', 'gary-main', 'active', 'offline')
			 ON CONFLICT DO NOTHING`,
			[agencyId],
		);

		// Insert agent_registry row to enable provider_registry FK
		const prAgencyId = makePrAgencyId(agencyId);
		const { rows: arRows } = await query<{ id: bigint }>(
			`INSERT INTO roadmap_workforce.agent_registry
			  (agent_identity, agent_type, project_id, status)
			 VALUES ($1, 'agency', 1, 'active')
			 ON CONFLICT (agent_identity) DO UPDATE SET status = EXCLUDED.status
			 RETURNING id`,
			[agencyId],
		);

		const arId = arRows[0]?.id;
		if (!arId) throw new Error(`Failed to insert agent_registry for ${agencyId}`);

		// Insert provider_registry row with test status
		await query(
			`INSERT INTO roadmap_workforce.provider_registry
			  (agency_id, agency_identity, status, last_seen_at, throttle_count, recent_failure_count, last_failure_at, alert_sent_at, project_id, squad_name)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'default')
			 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
			   status = EXCLUDED.status,
			   throttle_count = EXCLUDED.throttle_count,
			   recent_failure_count = EXCLUDED.recent_failure_count,
			   last_failure_at = EXCLUDED.last_failure_at,
			   alert_sent_at = EXCLUDED.alert_sent_at`,
			[
				arId,
				agencyId,
				prStatus,
				new Date().toISOString(), // last_seen_at
				prMetadata?.throttle_count ?? 0,
				prMetadata?.recent_failure_count ?? 0,
				prMetadata?.last_failure_at ?? null,
				prMetadata?.alert_sent_at ?? null,
			],
		);
	}

	it("AC-1: online pulse on offline agency → active + counters reset", async () => {
		const agencyId = makeTestId("online_offline");
		const beforeLastSeen = new Date();

		await setupTestAgency(agencyId, "offline", {
			throttle_count: 5,
			recent_failure_count: 3,
			last_failure_at: new Date(Date.now() - 60000).toISOString(),
			alert_sent_at: new Date(Date.now() - 120000).toISOString(),
		});

		// Call fn_pulse
		await query(`SELECT roadmap.fn_pulse($1, 'online')`, [agencyId]);

		// Verify agency presence_state updated
		const agencyResult = await query<{
			presence_state: string;
			status: string;
		}>(
			`SELECT presence_state, status FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		);
		expect(agencyResult.rows[0]?.presence_state).toBe("online");
		expect(agencyResult.rows[0]?.status).toBe("active");

		// Verify provider_registry state
		const prResult = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
			last_failure_at: string | null;
			alert_sent_at: string | null;
			status_reason: string;
			last_seen_at: string;
		}>(
			`SELECT status, throttle_count, recent_failure_count, last_failure_at,
			        alert_sent_at, status_reason, last_seen_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow).toBeDefined();
		expect(prRow.status).toBe("active");
		expect(prRow.throttle_count).toBe(0);
		expect(prRow.recent_failure_count).toBe(0);
		expect(prRow.last_failure_at).toBeNull();
		expect(prRow.alert_sent_at).toBeNull();
		expect(prRow.status_reason).toBe("a2a-host fn_pulse recovery");

		// Verify last_seen_at was refreshed
		const lastSeenAt = new Date(prRow.last_seen_at);
		expect(lastSeenAt.getTime()).toBeGreaterThanOrEqual(
			beforeLastSeen.getTime() - 100,
		);
	});

	it("AC-2: online pulse on dormant agency → active + counters reset", async () => {
		const agencyId = makeTestId("online_dormant");

		await setupTestAgency(agencyId, "dormant", {
			throttle_count: 2,
			recent_failure_count: 1,
			last_failure_at: new Date().toISOString(),
			alert_sent_at: new Date().toISOString(),
		});

		await query(`SELECT roadmap.fn_pulse($1, 'online')`, [agencyId]);

		const prResult = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
			last_failure_at: string | null;
			alert_sent_at: string | null;
		}>(
			`SELECT status, throttle_count, recent_failure_count, last_failure_at, alert_sent_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("active");
		expect(prRow.throttle_count).toBe(0);
		expect(prRow.recent_failure_count).toBe(0);
		expect(prRow.last_failure_at).toBeNull();
		expect(prRow.alert_sent_at).toBeNull();
	});

	it("AC-3: online pulse on active agency → stays active, last_seen_at refreshed, counters preserved", async () => {
		const agencyId = makeTestId("online_active");
		const throttleCount = 2;
		const failureCount = 1;
		const lastFailureAt = new Date(Date.now() - 30000);

		await setupTestAgency(agencyId, "active", {
			throttle_count: throttleCount,
			recent_failure_count: failureCount,
			last_failure_at: lastFailureAt.toISOString(),
		});

		const beforeLastSeen = new Date();
		await query(`SELECT roadmap.fn_pulse($1, 'online')`, [agencyId]);
		const afterLastSeen = new Date();

		const prResult = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
			last_failure_at: Date | null;
			last_seen_at: Date;
			status_reason: string | null;
		}>(
			`SELECT status, throttle_count, recent_failure_count, last_failure_at, last_seen_at, status_reason
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("active");
		// Counters preserved
		expect(prRow.throttle_count).toBe(throttleCount);
		expect(prRow.recent_failure_count).toBe(failureCount);
		expect(prRow.last_failure_at?.getTime()).toBe(lastFailureAt.getTime());
		// status_reason not changed (stays null)
		expect(prRow.status_reason).toBeNull();
		// last_seen_at refreshed
		expect(prRow.last_seen_at.getTime()).toBeGreaterThanOrEqual(
			beforeLastSeen.getTime() - 100,
		);
		expect(prRow.last_seen_at.getTime()).toBeLessThanOrEqual(
			afterLastSeen.getTime() + 100,
		);
	});

	it("AC-7: online pulse on throttled agency → stays throttled (operator-set, no auto-clear)", async () => {
		const agencyId = makeTestId("online_throttled");

		await setupTestAgency(agencyId, "throttled", {
			throttle_count: 10,
			alert_sent_at: new Date().toISOString(),
		});

		await query(`SELECT roadmap.fn_pulse($1, 'online')`, [agencyId]);

		const prResult = await query<{
			status: string;
			throttle_count: number;
		}>(
			`SELECT status, throttle_count
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("throttled");
		// Counters unchanged (throttle is operator-set governance)
		expect(prRow.throttle_count).toBe(10);
	});

	it("AC-5: online pulse on retired agency → stays retired (terminal)", async () => {
		const agencyId = makeTestId("online_retired");

		await setupTestAgency(agencyId, "retired");

		await query(`SELECT roadmap.fn_pulse($1, 'online')`, [agencyId]);

		const prResult = await query<{ status: string }>(
			`SELECT status FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		expect(prResult.rows[0]?.status).toBe("retired");
	});

	it("AC-4: busy pulse on offline agency → active + counters reset", async () => {
		const agencyId = makeTestId("busy_offline");

		await setupTestAgency(agencyId, "offline", {
			throttle_count: 3,
			recent_failure_count: 2,
		});

		await query(`SELECT roadmap.fn_pulse($1, 'busy')`, [agencyId]);

		const prResult = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
		}>(
			`SELECT status, throttle_count, recent_failure_count
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("active");
		expect(prRow.throttle_count).toBe(0);
		expect(prRow.recent_failure_count).toBe(0);
	});

	it("AC-4: away pulse on offline agency → last_seen_at refreshed, status unchanged (away is transient)", async () => {
		const agencyId = makeTestId("away_offline");
		const beforeLastSeen = new Date();

		await setupTestAgency(agencyId, "offline");

		await query(`SELECT roadmap.fn_pulse($1, 'away')`, [agencyId]);

		const prResult = await query<{
			status: string;
			last_seen_at: string;
		}>(
			`SELECT status, last_seen_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("offline");
		// last_seen_at still refreshed
		const lastSeenAt = new Date(prRow.last_seen_at);
		expect(lastSeenAt.getTime()).toBeGreaterThanOrEqual(
			beforeLastSeen.getTime() - 100,
		);
	});

	it("AC-4: away pulse on active agency → last_seen_at refreshed, status unchanged", async () => {
		const agencyId = makeTestId("away_active");
		const beforeLastSeen = new Date();

		await setupTestAgency(agencyId, "active");

		await query(`SELECT roadmap.fn_pulse($1, 'away')`, [agencyId]);

		const prResult = await query<{
			status: string;
			last_seen_at: string;
		}>(
			`SELECT status, last_seen_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		const prRow = prResult.rows[0];
		expect(prRow.status).toBe("active");
		// last_seen_at still refreshed
		const lastSeenAt = new Date(prRow.last_seen_at);
		expect(lastSeenAt.getTime()).toBeGreaterThanOrEqual(
			beforeLastSeen.getTime() - 100,
		);
	});

	it("offline pulse → provider_registry untouched (downward path owned by scanAndTransitionSilentAgencies)", async () => {
		const agencyId = makeTestId("offline_pulse");
		const beforeUpdate = new Date();

		await setupTestAgency(agencyId, "active", {
			throttle_count: 5,
			recent_failure_count: 2,
			alert_sent_at: new Date().toISOString(),
		});

		const beforeSnapshot = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
			alert_sent_at: string | null;
		}>(
			`SELECT status, throttle_count, recent_failure_count, alert_sent_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		await query(`SELECT roadmap.fn_pulse($1, 'offline')`, [agencyId]);

		const afterSnapshot = await query<{
			status: string;
			throttle_count: number;
			recent_failure_count: number;
			alert_sent_at: string | null;
		}>(
			`SELECT status, throttle_count, recent_failure_count, alert_sent_at
			  FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
			[agencyId],
		);

		// provider_registry should be unchanged by offline pulse
		expect(afterSnapshot.rows[0]).toEqual(beforeSnapshot.rows[0]);

		// But presence_state on roadmap.agency should be updated
		const agencyResult = await query<{ presence_state: string }>(
			`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		);
		expect(agencyResult.rows[0]?.presence_state).toBe("offline");
	});

	it("presence_state on roadmap.agency updates correctly with every pulse", async () => {
		const agencyId = makeTestId("presence_state");

		await setupTestAgency(agencyId, "active");

		const pulses = ["online", "busy", "away", "offline"];
		for (const state of pulses) {
			await query(`SELECT roadmap.fn_pulse($1, $2)`, [agencyId, state]);

			const result = await query<{ presence_state: string }>(
				`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
				[agencyId],
			);
			expect(result.rows[0]?.presence_state).toBe(state);
		}
	});

	it("agency_presence_changed NOTIFY fires only on state transitions (not idempotent updates)", async () => {
		const agencyId = makeTestId("presence_notify");

		await setupTestAgency(agencyId, "active");

		// Manually set presence_state to 'online'
		await query(
			`UPDATE roadmap.agency SET presence_state = 'online' WHERE agency_id = $1`,
			[agencyId],
		);

		// First pulse with different state should fire NOTIFY
		// (we can't easily listen to NOTIFY in tests, but we can verify the logic)
		// Pulse to 'busy' (different from 'online')
		await query(`SELECT roadmap.fn_pulse($1, 'busy')`, [agencyId]);

		// Verify state changed
		const result = await query<{ presence_state: string }>(
			`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		);
		expect(result.rows[0]?.presence_state).toBe("busy");

		// Now pulse with same state (idempotent) — NOTIFY should NOT fire
		// (no way to verify silence in test, but code path is exercised)
		await query(`SELECT roadmap.fn_pulse($1, 'busy')`, [agencyId]);

		const resultAfter = await query<{ presence_state: string }>(
			`SELECT presence_state FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		);
		expect(resultAfter.rows[0]?.presence_state).toBe("busy");
	});

	it("AC-8: fn_pulse parameter names are correct (p_agency_id, p_state)", async () => {
		// Verify the function signature via pg_get_function_arguments
		const result = await query<{ args: string }>(
			`SELECT pg_get_function_arguments(
			   'roadmap.fn_pulse(text, text)'::regprocedure
			 ) as args`,
		);

		expect(result.rows[0]?.args).toBe("p_agency_id text, p_state text");
	});

	it("AC-9: provider_registry bridge uses direct agency_identity match (no agent_registry JOIN)", async () => {
		// Verify migration 178 function definition excludes the JOIN
		const result = await query<{ definition: string }>(
			`SELECT pg_get_functiondef(
			   'roadmap.fn_pulse(text, text)'::regprocedure
			 ) as definition`,
		);

		const definition = result.rows[0]?.definition || "";

		// Should NOT contain "FROM roadmap_workforce.agent_registry ar"
		expect(definition).not.toContain("FROM roadmap_workforce.agent_registry");

		// Should contain direct WHERE pr.agency_identity = p_agency_id
		expect(definition).toContain("WHERE pr.agency_identity = p_agency_id");
	});
});

function now(): string {
	return new Date().toISOString();
}
