/**
 * V3-C6 (P1438) step 7: behavioral e2e test for AgencyClaimLoop self-claim.
 *
 * Proves the AgencyClaimLoop actually claims open work offers end-to-end, respects
 * the per-agency ceiling, carries correct metadata to onClaim, and cleans up on stop().
 * This is the "does the loop work?" verification — not structural source-grep, but
 * behavioral end-to-end: seeded offers, real DB state transitions, onClaim spy fired.
 *
 * Test structure mirrors p1433-atomic-claim.test.ts:
 *   - Dedicated scratch project (991438) that the live orchestrator is not
 *     subscribed to, so the live system cannot interfere.
 *   - Scratch agency seeded in agent_registry + provider_registry.
 *   - N open offers seeded with required_capabilities=['develop'] (non-empty per CHECK).
 *   - AgencyClaimLoop constructed with real pg connection, injected onClaim spy.
 *   - Loop started, tryClaim called, onClaim assertions verified.
 *   - Teardown deletes all scratch rows even on failure.
 *
 * Red-green proof:
 *   - If fn_claim_work_offer is broken (returns NULL) or doesn't flip offer_status,
 *     onClaim never fires -> assertions on claimedCount / heldByAgency fail.
 *   - If AgencyClaimLoop doesn't respect the ceiling, more claims fire than maxConcurrent
 *     and we can observe inFlightCount spike above max.
 *   - If AgencyClaimLoop.stop() doesn't close the listener, the listener pool client
 *     leaks (would need process inspection or secondary test to catch, but we assert
 *     stop() resolves and is idempotent).
 */

import { test, before, after } from "node:test";
import assert from "node:assert";
import { Client, Pool } from "pg";
import { AgencyClaimLoop, type AgencyClaimedOffer } from "../../src/infra/agency/agency-claim-loop.ts";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

// Unique scratch project so it doesn't collide with p1433 (990433) or real data.
const SCRATCH_PROJECT_ID = 991438;
const SCRATCH_AGENCY = "p1438-e2e-self-claim-agency";
const FK_PROPOSAL_ID = 1432; // P1432 umbrella — exists; used only for the proposal_id FK
const MAX_CLAIMS = 2;
const N_OFFERS = 5;

let pool: Pool;
let agencyDbId: number;

async function setup(): Promise<void> {
	// Scratch project — dedicated so the live orchestrator can't claim these offers.
	await pool.query(
		`INSERT INTO roadmap.project
		   (project_id, slug, name, worktree_root, status, host, port, bootstrap_status)
		 VALUES ($1, $2, $2, '/tmp/p1438-e2e', 'active', 'bot', 0, 'live')
		 ON CONFLICT (project_id) DO UPDATE SET status = 'active'`,
		[SCRATCH_PROJECT_ID, "p1438-e2e-self-claim"],
	);

	// Scratch agency with a low ceiling so over-claim is unambiguous.
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, max_concurrent_claims, project_id)
		 VALUES ($1, 'agency', 'active', $2, $3)
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET status = 'active', max_concurrent_claims = $2, project_id = $3
		 RETURNING id`,
		[SCRATCH_AGENCY, MAX_CLAIMS, SCRATCH_PROJECT_ID],
	);
	agencyDbId = rows[0].id;

	// Subscribe the scratch agency to the scratch project (Gate 6 project scope).
	await pool.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, status, is_active, capabilities)
		 VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
		 ON CONFLICT DO NOTHING`,
		[agencyDbId, SCRATCH_AGENCY, SCRATCH_PROJECT_ID],
	);

	// N open offers on the scratch project. required_capabilities must be a
	// non-empty array (sd_required_capabilities_nonempty CHECK); the loop passes
	// its real caps which short-circuits fn_claim's capability gate.
	for (let i = 0; i < N_OFFERS; i++) {
		await pool.query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, project_id, squad_name, dispatch_role,
			    dispatch_status, offer_status, required_capabilities, idempotency_key)
			 VALUES ($1, $2, $3, 'developer', 'open', 'open',
			         '["develop"]'::jsonb, $4)`,
			[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `p1438-e2e-${i}`, `p1438-e2e:${i}`],
		);
	}
}

async function teardown(): Promise<void> {
	try {
		// Delete in correct order to respect FK constraints
		await pool.query(`DELETE FROM roadmap_workforce.squad_dispatch WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap_workforce.provider_registry WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap_workforce.agent_registry WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
		await pool.query(`DELETE FROM roadmap.project WHERE project_id = $1`, [SCRATCH_PROJECT_ID]);
	} catch (e) {
		console.error("teardown error (continuing):", e instanceof Error ? e.message : e);
	}
}

before(async () => {
	pool = new Pool({ connectionString: DB_URL, max: 10 });
	await teardown(); // clear any residue from a prior aborted run
	await setup();
});

after(async () => {
	await teardown();
	await pool.end();
});

/**
 * Helper: set up a fresh scratch agency + offers for this test iteration,
 * independent of the global before()/after() hooks. This ensures each test
 * starts with a clean slate even if prior tests modified the DB.
 */
async function setupTestAgency(testAgencyName: string): Promise<void> {
	// Scratch agency with a low ceiling so over-claim is unambiguous.
	const { rows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, max_concurrent_claims, project_id)
		 VALUES ($1, 'agency', 'active', $2, $3)
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET status = 'active', max_concurrent_claims = $2, project_id = $3
		 RETURNING id`,
		[testAgencyName, MAX_CLAIMS, SCRATCH_PROJECT_ID],
	);
	const testAgencyDbId = rows[0].id;

	// Subscribe the scratch agency to the scratch project (Gate 6 project scope).
	await pool.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, status, is_active, capabilities)
		 VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
		 ON CONFLICT DO NOTHING`,
		[testAgencyDbId, testAgencyName, SCRATCH_PROJECT_ID],
	);

	// N open offers on the scratch project.
	for (let i = 0; i < N_OFFERS; i++) {
		await pool.query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			   (proposal_id, project_id, squad_name, dispatch_role,
			    dispatch_status, offer_status, required_capabilities, idempotency_key)
			 VALUES ($1, $2, $3, 'developer', 'open', 'open',
			         '["develop"]'::jsonb, $4)`,
			[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID, `${testAgencyName}-${i}`, `${testAgencyName}:${i}`],
		);
	}
}

/**
 * Helper: clean up a test agency and its offers.
 */
async function teardownTestAgency(testAgencyName: string): Promise<void> {
	try {
		// Delete in correct order to respect FK constraints
		await pool.query(
			`DELETE FROM roadmap_workforce.squad_dispatch
			  WHERE squad_name LIKE $1 OR squad_name LIKE $2`,
			[`${testAgencyName}-%`, `${testAgencyName}:%`],
		);
		await pool.query(`DELETE FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`, [
			testAgencyName,
		]);
		await pool.query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [
			testAgencyName,
		]);
	} catch (e) {
		console.error(`teardownTestAgency(${testAgencyName}) error:`, e instanceof Error ? e.message : e);
	}
}

/**
 * AC-1: AgencyClaimLoop claims an eligible open offer and flips offer_status
 * from 'open' to 'claimed', AND invokes onClaim with correct payload.
 */
test("P1438 AC-1: AgencyClaimLoop claims an eligible open offer end-to-end", async () => {
	const testAgencyName = "p1438-e2e-ac1-agency";
	await setupTestAgency(testAgencyName);

	const claimedOffers: AgencyClaimedOffer[] = [];
	const onClaimSpy = async (claim: AgencyClaimedOffer): Promise<void> => {
		claimedOffers.push(claim);
	};

	// Create a dedicated listener client (NOT from pool, so stop() can .end() it).
	const connectListener = async () => {
		const client = new Client({ connectionString: DB_URL });
		await client.connect();
		return client;
	};

	const loop = new AgencyClaimLoop({
		agencyIdentity: testAgencyName,
		capabilities: ["develop"], // Agency claims it can do "develop" work
		onClaim: onClaimSpy,
		connectListener,
		projectId: SCRATCH_PROJECT_ID,
		maxConcurrent: MAX_CLAIMS,
		logger: console,
	});

	await loop.start();

	// Give the loop time to poll and claim (poll interval default 30s is too slow for
	// test; call tryClaim directly by waiting for the first claim). In practice the
	// LISTEN notification fires immediately after start() does its first tryClaim().
	// For the test, we poll the DB until an offer is claimed (with a reasonable timeout).
	const pollUntilClaimed = async (): Promise<boolean> => {
		const maxWait = 5000; // 5 seconds total
		const pollInterval = 100;
		const endTime = Date.now() + maxWait;
		while (Date.now() < endTime) {
			const { rows } = await pool.query<{ n: string }>(
				`SELECT COUNT(*)::text AS n
				   FROM roadmap_workforce.squad_dispatch
				  WHERE project_id = $1 AND offer_status = 'claimed' AND agency_identity = $2`,
				[SCRATCH_PROJECT_ID, testAgencyName],
			);
			if (Number(rows[0].n) > 0) return true;
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
		}
		return false;
	};

	const claimed = await pollUntilClaimed();
	assert.ok(claimed, "no offers were claimed by the loop within 5s");

	// Assertion: onClaim was invoked (i.e. spy was called).
	assert.ok(claimedOffers.length > 0, "onClaim spy was not invoked");

	// Assertion: the first claimed offer has all required fields.
	const claim = claimedOffers[0]!;
	assert.ok(claim.offerId, "claim.offerId is missing");
	assert.ok(claim.dispatchId, "claim.dispatchId is missing");
	assert.ok(claim.proposalId, "claim.proposalId is missing");
	assert.ok(claim.squadName, "claim.squadName is missing");
	assert.ok(claim.role, "claim.role is missing");
	assert.ok(claim.claimToken, "claim.claimToken is missing");
	assert.ok(claim.claimExpiresAt, "claim.claimExpiresAt is missing");

	// Assertion: offer_status was flipped to 'claimed' in the DB.
	const { rows } = await pool.query<{ agent_id: string; offer_status: string }>(
		`SELECT agency_identity AS agent_id, offer_status
		   FROM roadmap_workforce.squad_dispatch
		  WHERE id = $1`,
		[claim.dispatchId],
	);
	assert.equal(
		rows[0]?.offer_status,
		"claimed",
		"offer_status was not flipped to 'claimed'",
	);
	assert.equal(
		rows[0]?.agent_id,
		testAgencyName,
		"offer_status was not flipped by the correct agency",
	);

	await loop.stop();
	await teardownTestAgency(testAgencyName);
});

/**
 * AC-2: AgencyClaimLoop respects the per-agency max_concurrent_claims ceiling.
 * With maxConcurrent=2 and N_OFFERS=5, the loop should claim only up to the
 * ceiling, not all 5 offers.
 */
test("P1438 AC-2: AgencyClaimLoop respects per-agency ceiling", async () => {
	const testAgencyName = "p1438-e2e-ac2-agency";
	await setupTestAgency(testAgencyName);

	let inFlightMax = 0;
	let inFlightCurrent = 0;

	const onClaimSpy = async (claim: AgencyClaimedOffer): Promise<void> => {
		inFlightCurrent++;
		inFlightMax = Math.max(inFlightMax, inFlightCurrent);
		// Simulate a long-running task so concurrency is observable.
		await new Promise((resolve) => setTimeout(resolve, 200));
		inFlightCurrent--;
	};

	const connectListener = async () => {
		const client = new Client({ connectionString: DB_URL });
		await client.connect();
		return client;
	};

	const loop = new AgencyClaimLoop({
		agencyIdentity: testAgencyName,
		capabilities: ["develop"],
		onClaim: onClaimSpy,
		connectListener,
		projectId: SCRATCH_PROJECT_ID,
		maxConcurrent: MAX_CLAIMS,
		pollIntervalMs: 100, // Poll more aggressively for test
		logger: console,
	});

	await loop.start();

	// Wait for claims to complete (or timeout).
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Count how many offers are claimed in the DB.
	const { rows } = await pool.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM roadmap_workforce.squad_dispatch
		  WHERE project_id = $1 AND offer_status = 'claimed' AND agency_identity = $2`,
		[SCRATCH_PROJECT_ID, testAgencyName],
	);
	const claimedCount = Number(rows[0].n);

	// Assertion: claimed count should not exceed the ceiling.
	assert.ok(
		claimedCount <= MAX_CLAIMS,
		`claimed ${claimedCount} offers, exceeds ceiling ${MAX_CLAIMS}`,
	);

	// Assertion: should have claimed AT LEAST some offers (there were 5 available).
	assert.ok(claimedCount > 0, "no offers were claimed despite 5 being available");

	// Assertion: observed in-flight concurrency should not exceed the ceiling.
	assert.ok(
		inFlightMax <= MAX_CLAIMS,
		`in-flight concurrency peaked at ${inFlightMax}, exceeds ceiling ${MAX_CLAIMS}`,
	);

	await loop.stop();
	await teardownTestAgency(testAgencyName);
});

/**
 * AC-3: AgencyClaimLoop.stop() closes the LISTEN connection cleanly and is idempotent.
 */
test("P1438 AC-3: AgencyClaimLoop.stop() closes connection and is idempotent", async () => {
	const testAgencyName = "p1438-e2e-ac3-agency";
	await setupTestAgency(testAgencyName);

	const onClaimSpy = async (claim: AgencyClaimedOffer): Promise<void> => {
		// No-op for this test
	};

	const connectListener = async () => {
		const client = new Client({ connectionString: DB_URL });
		await client.connect();
		return client;
	};

	const loop = new AgencyClaimLoop({
		agencyIdentity: testAgencyName,
		capabilities: ["develop"],
		onClaim: onClaimSpy,
		connectListener,
		projectId: SCRATCH_PROJECT_ID,
		maxConcurrent: MAX_CLAIMS,
		logger: console,
	});

	// Start and then stop the loop.
	await loop.start();
	await loop.stop();

	// Assertion: stop() resolves without throwing.
	// (implicit above, but explicit here for clarity)

	// Assertion: second stop() is safe (idempotent).
	await assert.doesNotReject(() => loop.stop(), "second stop() threw an error");

	// Assertion: starting again after stop() is safe.
	await assert.doesNotReject(() => loop.start(), "start() after stop() threw an error");

	// Clean up the second start.
	await loop.stop();
	await teardownTestAgency(testAgencyName);
});

/**
 * AC-4: AgencyClaimLoop respects the capability gate — it does NOT claim offers
 * whose required_capabilities don't intersect with the agency's declared capabilities.
 */
test("P1438 AC-4: AgencyClaimLoop respects capability filtering", async () => {
	const testAgencyName = "p1438-e2e-ac4-agency";

	// Set up an agency with "review" capability.
	const { rows: agencyRows } = await pool.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status, max_concurrent_claims, project_id)
		 VALUES ($1, 'agency', 'active', $2, $3)
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET status = 'active', max_concurrent_claims = $2, project_id = $3
		 RETURNING id`,
		[testAgencyName, MAX_CLAIMS, SCRATCH_PROJECT_ID],
	);
	const testAgencyDbId = agencyRows[0].id;

	// Subscribe to the project.
	await pool.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, project_id, status, is_active, capabilities)
		 VALUES ($1, $2, $3, 'active', true, '{}'::jsonb)
		 ON CONFLICT DO NOTHING`,
		[testAgencyDbId, testAgencyName, SCRATCH_PROJECT_ID],
	);

	// Seed offers: one with ["develop"] (agency CANNOT claim), one with ["review"] (agency CAN claim).
	// Since the agency only has ["review"], it should skip the develop-only offer.
	await pool.query(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role,
		    dispatch_status, offer_status, required_capabilities, idempotency_key)
		 VALUES ($1, $2, 'develop-only', 'developer', 'open', 'open',
		         '["develop"]'::jsonb, 'develop-only:unique')`,
		[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID],
	);
	await pool.query(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, project_id, squad_name, dispatch_role,
		    dispatch_status, offer_status, required_capabilities, idempotency_key)
		 VALUES ($1, $2, 'review-only', 'reviewer', 'open', 'open',
		         '["review"]'::jsonb, 'review-only:unique')`,
		[FK_PROPOSAL_ID, SCRATCH_PROJECT_ID],
	);

	const claimedOffers: AgencyClaimedOffer[] = [];
	const onClaimSpy = async (claim: AgencyClaimedOffer): Promise<void> => {
		claimedOffers.push(claim);
	};

	const connectListener = async () => {
		const client = new Client({ connectionString: DB_URL });
		await client.connect();
		return client;
	};

	const loop = new AgencyClaimLoop({
		agencyIdentity: testAgencyName,
		capabilities: ["review"], // Only declare "review" capability
		onClaim: onClaimSpy,
		connectListener,
		projectId: SCRATCH_PROJECT_ID,
		maxConcurrent: MAX_CLAIMS,
		logger: console,
	});

	await loop.start();

	// Wait for claims (should find the "review" offer only).
	const pollUntilClaimed = async (): Promise<boolean> => {
		const maxWait = 5000;
		const pollInterval = 100;
		const endTime = Date.now() + maxWait;
		while (Date.now() < endTime) {
			const { rows } = await pool.query<{ n: string }>(
				`SELECT COUNT(*)::text AS n
				   FROM roadmap_workforce.squad_dispatch
				  WHERE project_id = $1 AND offer_status = 'claimed' AND agency_identity = $2`,
				[SCRATCH_PROJECT_ID, testAgencyName],
			);
			if (Number(rows[0].n) > 0) return true;
			await new Promise((resolve) => setTimeout(resolve, pollInterval));
		}
		return false;
	};

	const claimed = await pollUntilClaimed();
	assert.ok(claimed, "agency with ['review'] should have claimed the review-only offer");

	// Assertion: verify which offer was claimed.
	const { rows } = await pool.query<{ squad_name: string }>(
		`SELECT squad_name FROM roadmap_workforce.squad_dispatch
		  WHERE project_id = $1 AND offer_status = 'claimed' AND agency_identity = $2`,
		[SCRATCH_PROJECT_ID, testAgencyName],
	);
	assert.equal(rows.length, 1, "should have claimed exactly 1 offer");
	assert.equal(rows[0].squad_name, "review-only", "should have claimed the review-only offer, not the develop-only offer (capability mismatch)");

	// Assertion: the develop-only offer should still be open (not claimed).
	const { rows: unclaimed } = await pool.query<{ squad_name: string; offer_status: string }>(
		`SELECT squad_name, offer_status FROM roadmap_workforce.squad_dispatch
		  WHERE project_id = $1 AND squad_name = 'develop-only'`,
		[SCRATCH_PROJECT_ID],
	);
	assert.equal(unclaimed[0].offer_status, "open", "develop-only offer should remain open (capability mismatch prevents claim)");

	await loop.stop();
	await teardownTestAgency(testAgencyName);
});
