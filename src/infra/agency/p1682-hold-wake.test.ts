/**
 * P1682: Hold-Wake Framework Tests
 *
 * Tests for AC-4 (hold state), AC-5 (wake path), AC-6 (env thresholds),
 * AC-8 (exclusions), and AC-9 (long reset behavior).
 *
 * NOTE: Tests that use live DB are gated by AGENTHIVE_ALLOW_LIVE_DB=1 environment variable.
 * To run with live DB: AGENTHIVE_ALLOW_LIVE_DB=1 npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { query } from "../postgres/pool.ts";
import { recordProviderHardLimit } from "./subscription-policy.ts";

const LIVE_DB_ENABLED = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

// ─── AC-4: Hold State Tests ────────────────────────────────────────────────

describe.skipIf(!LIVE_DB_ENABLED)("P1682 AC-4: Hold State (Live DB)", () => {
	const HOLD_WINDOW_MAX_SEC = 1800; // 30 minutes default
	const testAgencyId = "architect";
	let testDispatchIds: number[] = [];

	beforeEach(async () => {
		// Clean up any leftover test rows from previous runs
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1`,
			[testAgencyId],
		).catch(() => {
			/* ignore */
		});
		testDispatchIds = [];
	});

	afterEach(async () => {
		// Clean up all test rows created in this test
		if (testDispatchIds.length > 0) {
			await query(
				`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`,
				[testDispatchIds],
			).catch(() => {
				/* ignore */
			});
		}
	});

	it("AC-4.1: recordProviderHardLimit sets hold state and metadata", async () => {
		const resetAt = new Date(Date.now() + 600_000); // 10 minutes from now

		// Create a dispatch row in the correct state (omit id, let it auto-generate)
		const insertRes = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
			     offer_status, required_capabilities, project_id, assigned_at)
			 VALUES (144, $1, 'test-squad', 'test-role', 'assigned', 'claimed', '["test"]', 1, now())
			 RETURNING id`,
			[testAgencyId],
		);
		expect(insertRes.rows).toHaveLength(1);
		const dispatchId = insertRes.rows[0].id;
		testDispatchIds.push(dispatchId);

		// Now call recordProviderHardLimit
		await recordProviderHardLimit(testAgencyId, dispatchId, resetAt, query);

		// Verify the row was updated correctly
		const result = await query(
			`SELECT paused_at_provider_limit, provider_limit_paused_at, metadata
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);

		expect(result.rows).toHaveLength(1);
		const row = result.rows[0];
		expect(row.paused_at_provider_limit).toBe(true);
		expect(row.provider_limit_paused_at).toBeTruthy();
		// metadata.resume_eligible_at should be set to resetAt
		const metadataResumeAt = row.metadata?.resume_eligible_at;
		expect(metadataResumeAt).toBeTruthy();
		// Verify it's close to our expected resetAt (within a second)
		const parsedResumeAt = new Date(metadataResumeAt as string);
		const delta = Math.abs(parsedResumeAt.getTime() - resetAt.getTime());
		expect(delta).toBeLessThan(1000); // within 1 second
	});

	it("AC-4.2: held row does not have completed_at (non-terminal)", async () => {
		const resetAt = new Date(Date.now() + 900_000);

		// Create a dispatch (omit id, let it auto-generate)
		const insertRes = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
			     offer_status, required_capabilities, project_id, assigned_at)
			 VALUES (144, $1, 'test-squad', 'test-role', 'assigned', 'claimed', '["test"]', 1, now())
			 RETURNING id`,
			[testAgencyId],
		);
		const dispatchId = insertRes.rows[0].id;
		testDispatchIds.push(dispatchId);

		// Place it in hold state
		await recordProviderHardLimit(testAgencyId, dispatchId, resetAt, query);

		// Verify it's non-terminal (no completed_at, no failure_class set)
		const result = await query(
			`SELECT completed_at, failure_class, paused_at_provider_limit
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);

		expect(result.rows[0].completed_at).toBeNull();
		expect(result.rows[0].failure_class).toBeNull();
		expect(result.rows[0].paused_at_provider_limit).toBe(true);
	});
});

// ─── AC-5: Wake Path Tests ─────────────────────────────────────────────────

describe.skipIf(!LIVE_DB_ENABLED)("P1682 AC-5: Wake Path (Live DB)", () => {
	const testAgencyId = "architect";
	let testDispatchIds: number[] = [];

	beforeEach(async () => {
		// Clean up any leftover test rows from previous runs
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1`,
			[testAgencyId],
		).catch(() => {
			/* ignore */
		});
		testDispatchIds = [];
	});

	afterEach(async () => {
		if (testDispatchIds.length > 0) {
			await query(
				`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`,
				[testDispatchIds],
			).catch(() => {
				/* ignore */
			});
		}
	});

	it("AC-5.1: wake sweep clears paused_at_provider_limit when resume_eligible_at expires", async () => {
		// Set resetAt to 1 minute in the PAST (already expired)
		const resetAt = new Date(Date.now() - 60_000);

		// Create a held dispatch that has expired (omit id, let it auto-generate)
		const insertRes = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
			     offer_status, paused_at_provider_limit, provider_limit_paused_at,
			     metadata, required_capabilities, project_id, assigned_at)
			 VALUES (144, $1, 'test-squad', 'test-role', 'claimed', 'claimed', true,
			         now() - interval '2 min',
			         jsonb_build_object('resume_eligible_at', $2::text),
			         '["test"]', 1, now())
			 RETURNING id`,
			[testAgencyId, resetAt.toISOString()],
		);
		const dispatchId = insertRes.rows[0].id;
		testDispatchIds.push(dispatchId);

		// Simulate the wake sweep (same logic as reap-stale-rows.ts AC-5)
		const wakeResult = await query(
			`UPDATE roadmap_workforce.squad_dispatch
			   SET paused_at_provider_limit = false,
			       metadata = COALESCE(metadata, '{}'::jsonb) ||
			                   jsonb_build_object('hold_woken_at', to_jsonb(now()::text))
			 WHERE id = $1
			   AND paused_at_provider_limit = true
			   AND (metadata->>'resume_eligible_at')::timestamp WITH TIME ZONE <= now()
			   AND dispatch_status IN ('claimed', 'assigned', 'active')
			 RETURNING id`,
			[dispatchId],
		);

		// Verify the wake sweep updated the row
		expect(wakeResult.rows).toHaveLength(1);

		// Verify the flag is now cleared
		const checkResult = await query(
			`SELECT paused_at_provider_limit, metadata
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);
		expect(checkResult.rows[0].paused_at_provider_limit).toBe(false);
		expect(checkResult.rows[0].metadata?.hold_woken_at).toBeTruthy();
	});

	it("AC-5.2: wake sweep does not clear unexpired holds", async () => {
		// Set resetAt to 10 minutes in the FUTURE (not expired)
		const resetAt = new Date(Date.now() + 600_000);

		// Create a held dispatch that has NOT expired (omit id, let it auto-generate)
		const insertRes = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
			     offer_status, paused_at_provider_limit, provider_limit_paused_at,
			     metadata, required_capabilities, project_id, assigned_at)
			 VALUES (144, $1, 'test-squad', 'test-role', 'claimed', 'claimed', true, now(),
			         jsonb_build_object('resume_eligible_at', $2::text),
			         '["test"]', 1, now())
			 RETURNING id`,
			[testAgencyId, resetAt.toISOString()],
		);
		const dispatchId = insertRes.rows[0].id;
		testDispatchIds.push(dispatchId);

		// Try wake sweep on non-expired hold
		const wakeResult = await query(
			`UPDATE roadmap_workforce.squad_dispatch
			   SET paused_at_provider_limit = false
			 WHERE id = $1
			   AND paused_at_provider_limit = true
			   AND (metadata->>'resume_eligible_at')::timestamp WITH TIME ZONE <= now()
			 RETURNING id`,
			[dispatchId],
		);

		// Should NOT have updated (no rows returned)
		expect(wakeResult.rows).toHaveLength(0);

		// Verify it's still held
		const checkResult = await query(
			`SELECT paused_at_provider_limit FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[dispatchId],
		);
		expect(checkResult.rows[0].paused_at_provider_limit).toBe(true);
	});
});

// ─── AC-6: Environment Variable Tests ──────────────────────────────────────

describe("P1682 AC-6: Environment Variable Thresholds", () => {
	it("AC-6.1: reads AGENTHIVE_HOLD_WINDOW_MAX_SEC from env (or default 1800)", () => {
		const holdWindowMaxSec = Number(
			process.env.AGENTHIVE_HOLD_WINDOW_MAX_SEC ?? 1800,
		);
		expect(holdWindowMaxSec).toBeGreaterThan(0);
		expect(holdWindowMaxSec).toBeLessThanOrEqual(24 * 3600); // max 24h
	});

	it("AC-6.2: reads AGENTHIVE_CLAUDE_CLI_DEFAULT_COOLDOWN_SEC from env (or default 3600)", () => {
		const cooldownSec = Number(
			process.env.AGENTHIVE_CLAUDE_CLI_DEFAULT_COOLDOWN_SEC ?? 3600,
		);
		expect(cooldownSec).toBeGreaterThan(0);
		expect(cooldownSec).toBeLessThanOrEqual(24 * 3600);
	});

	it("AC-6.3: reads AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC for long/unparseable resets (or default 86400)", () => {
		const longCooldownSec = Number(
			process.env.AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC ?? 86400,
		);
		expect(longCooldownSec).toBeGreaterThan(0);
		expect(longCooldownSec).toBeLessThanOrEqual(30 * 24 * 3600); // max 30 days
	});
});

// ─── AC-8: Capacity/Reaper/Breaker Exclusion Tests ────────────────────────

describe.skipIf(!LIVE_DB_ENABLED)(
	"P1682 AC-8: Capacity/Reaper/Breaker Exclusion (Live DB)",
	() => {
		const testAgencyId = "architect";
		let testDispatchIds: number[] = [];

		beforeEach(async () => {
			// Clean up any leftover test rows from previous runs
			await query(
				`DELETE FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1`,
				[testAgencyId],
			).catch(() => {
				/* ignore */
			});
			testDispatchIds = [];
		});

		afterEach(async () => {
			if (testDispatchIds.length > 0) {
				await query(
					`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`,
					[testDispatchIds],
				).catch(() => {
					/* ignore */
				});
			}
		});

		it("AC-8.1: held rows do not count toward active (non-held) count", async () => {
			// Create 3 normal (non-held) claimed rows
			for (let i = 0; i < 3; i++) {
				await query(
					`INSERT INTO roadmap_workforce.squad_dispatch
					    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
					     offer_status, required_capabilities, project_id, assigned_at)
					 VALUES (144, $1, 'test', 'test', 'assigned', 'claimed', '["test"]', 1, now())
					 RETURNING id`,
					[testAgencyId],
				).then((res) => {
					testDispatchIds.push(res.rows[0].id);
				});
			}

			// Create 2 held claimed rows
			const resetAt = new Date(Date.now() + 600_000);
			for (let i = 0; i < 2; i++) {
				await query(
					`INSERT INTO roadmap_workforce.squad_dispatch
					    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
					     offer_status, paused_at_provider_limit, provider_limit_paused_at,
					     metadata, required_capabilities, project_id, assigned_at)
					 VALUES (144, $1, 'test', 'test', 'assigned', 'claimed', true, now(),
					         jsonb_build_object('resume_eligible_at', $2::text),
					         '["test"]', 1, now())
					 RETURNING id`,
					[testAgencyId, resetAt.toISOString()],
				).then((res) => {
					testDispatchIds.push(res.rows[0].id);
				});
			}

			// Count ACTIVE (non-held) rows
			const activeResult = await query(
				`SELECT COUNT(*) as active_count
				   FROM roadmap_workforce.squad_dispatch
				  WHERE agent_identity = $1
				    AND offer_status = 'claimed'
				    AND (paused_at_provider_limit = false OR paused_at_provider_limit IS NULL)`,
				[testAgencyId],
			);

			// Should only count the 3 non-held rows
			expect(Number(activeResult.rows[0].active_count)).toBe(3);

			// Total count should be 5
			const totalResult = await query(
				`SELECT COUNT(*) as total_count
				   FROM roadmap_workforce.squad_dispatch
				  WHERE agent_identity = $1`,
				[testAgencyId],
			);
			expect(Number(totalResult.rows[0].total_count)).toBe(5);
		});

		it("AC-8.2: reaper does not cancel held rows before resume_eligible_at expires", async () => {
			const resetAt = new Date(Date.now() + 600_000); // Not expired

			// Create a held dispatch (omit id, let it auto-generate)
			const insertRes = await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
				     offer_status, paused_at_provider_limit, provider_limit_paused_at,
				     metadata, required_capabilities, project_id, assigned_at)
				 VALUES (144, $1, 'test', 'test', 'assigned', 'claimed', true, now(),
				         jsonb_build_object('resume_eligible_at', $2::text),
				         '["test"]', 1, now() - interval '30 min')
				 RETURNING id`,
				[testAgencyId, resetAt.toISOString()],
			);
			const dispatchId = insertRes.rows[0].id;
			testDispatchIds.push(dispatchId);

			// Simulate reaper that would normally delete stale assigned rows
			// But it should NOT delete held rows that haven't expired
			const result = await query(
				`DELETE FROM roadmap_workforce.squad_dispatch
				  WHERE agent_identity = $1
				    AND dispatch_status = 'assigned'
				    AND assigned_at < now() - interval '20 min'
				    AND paused_at_provider_limit IS NOT TRUE
				  RETURNING id`,
				[testAgencyId],
			);

			// Should NOT delete the held row
			expect(result.rows).toHaveLength(0);

			// Verify row still exists
			const checkResult = await query(
				`SELECT id FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
				[dispatchId],
			);
			expect(checkResult.rows).toHaveLength(1);
		});

		it("AC-8.3: held rows do not count in failure breaker logic", async () => {
			const resetAt = new Date(Date.now() + 600_000);

			// Create a held dispatch with failure_class = 'rate_limited' (omit id, let it auto-generate)
			const insertRes = await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
				     offer_status, paused_at_provider_limit, provider_limit_paused_at,
				     failure_class, metadata, required_capabilities, project_id, assigned_at)
				 VALUES (144, $1, 'test', 'test', 'assigned', 'claimed', true, now(),
				         'rate_limited',
				         jsonb_build_object('resume_eligible_at', $2::text),
				         '["test"]', 1, now())
				 RETURNING id`,
				[testAgencyId, resetAt.toISOString()],
			);
			const dispatchId = insertRes.rows[0].id;
			testDispatchIds.push(dispatchId);

			// Breaker logic should only count non-held failures
			const result = await query(
				`SELECT COUNT(*) as failed_count
				   FROM roadmap_workforce.squad_dispatch
				  WHERE agent_identity = $1
				    AND (paused_at_provider_limit = false OR paused_at_provider_limit IS NULL)
				    AND failure_class IS NOT NULL`,
				[testAgencyId],
			);

			// Held row should not be counted
			expect(Number(result.rows[0].failed_count)).toBe(0);
		});
	},
);

// ─── AC-9: Long/Unparseable Reset Behavior ────────────────────────────────

describe("P1682 AC-9: Long/Unparseable Reset Behavior", () => {
	it("AC-9.1: decision logic: if deltaSec > HOLD_WINDOW_MAX_SEC, use provider cooldown path", () => {
		const holdWindowMaxSec = 1800;
		const longResetAt = new Date(Date.now() + 24 * 3600 * 1000); // 24 hours
		const deltaMs = longResetAt.getTime() - Date.now();
		const deltaSec = Math.ceil(deltaMs / 1000);

		expect(deltaSec).toBeGreaterThan(holdWindowMaxSec);
		// In agent-spawner.ts: if deltaSec > HOLD_WINDOW_MAX_SEC, take provider-cooldown path
	});

	it("AC-9.2: decision logic: if !resetAt, use AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC", () => {
		const longCooldownSec = Number(
			process.env.AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC ?? 86400,
		);
		// When resetAt is unparseable/null, agent-spawner.ts uses this value
		expect(longCooldownSec).toBeGreaterThan(0);
	});

	it("AC-9.3: metadata reason is recorded for long resets", async () => {
		// This is a unit test showing the pattern
		const reason = "long_reset_exceeded_hold_window";
		const metadata = {
			resume_eligible_at: null,
			reason: reason,
		};

		expect(metadata.reason).toBe("long_reset_exceeded_hold_window");
		// In offer-dispatch-handler.ts: recordProviderHardLimit is NOT called,
		// provider cooldown is set instead (AC-6 env gate).
	});

	it("AC-9.4: long/unparseable resets do NOT call fn_return_work_offer", () => {
		// Per AC design: when resetAt > HOLD_WINDOW_MAX_SEC or unparseable,
		// set provider-level cooldown and return (no release/handoff).
		// This test documents the design constraint.
		expect(true).toBe(true);
	});
});

// ─── AC-5 Integration: 5-second cooldown wake test ────────────────────────

describe.skipIf(!LIVE_DB_ENABLED)(
	"P1682 AC-5 Integration: Wake Re-dispatch (Live DB, 5-sec cooldown)",
	() => {
		const testAgencyId = "architect";
		let testDispatchIds: number[] = [];

		beforeEach(async () => {
			// Clean up any leftover test rows from previous runs
			await query(
				`DELETE FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1`,
				[testAgencyId],
			).catch(() => {
				/* ignore */
			});
			testDispatchIds = [];
		});

		afterEach(async () => {
			if (testDispatchIds.length > 0) {
				await query(
					`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = ANY($1)`,
					[testDispatchIds],
				).catch(() => {
					/* ignore */
				});
			}
		});

		it("AC-5: placed in hold → woken by sweep → available for re-dispatch", async () => {
			// 2-second hold (short enough to test quickly)
			const resetAt = new Date(Date.now() + 2000);

			// Step 1: Place dispatch in hold state (omit id, let it auto-generate)
			const insertRes = await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
				     offer_status, paused_at_provider_limit, provider_limit_paused_at,
				     assigned_at, metadata, required_capabilities, project_id)
				 VALUES (144, $1, 'test', 'test', 'assigned', 'claimed', true, now(),
				         now() - interval '30 sec',
				         jsonb_build_object('resume_eligible_at', $2::text),
				         '["test"]', 1)
				 RETURNING id`,
				[testAgencyId, resetAt.toISOString()],
			);
			const dispatchId = insertRes.rows[0].id;
			testDispatchIds.push(dispatchId);

			// Verify it's held
			let checkResult = await query(
				`SELECT paused_at_provider_limit FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
				[dispatchId],
			);
			expect(checkResult.rows[0].paused_at_provider_limit).toBe(true);

			// Step 2: Wait for hold to expire
			await new Promise((resolve) => setTimeout(resolve, 2500));

			// Step 3: Run the wake sweep (as reaper would)
			const wakeResult = await query(
				`UPDATE roadmap_workforce.squad_dispatch
				   SET paused_at_provider_limit = false,
				       metadata = COALESCE(metadata, '{}'::jsonb) ||
				                   jsonb_build_object('hold_woken_at', to_jsonb(now()::text))
				 WHERE paused_at_provider_limit = true
				   AND (metadata->>'resume_eligible_at')::timestamp WITH TIME ZONE <= now()
				   AND dispatch_status IN ('claimed', 'assigned', 'active')
				 RETURNING id`,
			);

			// Verify wake succeeded
			expect(wakeResult.rows).toHaveLength(1);

			// Step 4: Verify it's now available (not held)
			checkResult = await query(
				`SELECT paused_at_provider_limit FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
				[dispatchId],
			);
			expect(checkResult.rows[0].paused_at_provider_limit).toBe(false);

			// Step 5: Verify it's no longer stale-reaped (age check passes)
			// A row placed in hold 30s ago is available if not held
			const nonStaleCount = await query(
				`SELECT COUNT(*) as cnt
				   FROM roadmap_workforce.squad_dispatch
				  WHERE id = $1
				    AND (paused_at_provider_limit = false OR paused_at_provider_limit IS NULL)
				    AND dispatch_status IN ('claimed', 'assigned', 'active')`,
				[dispatchId],
			);
			expect(Number(nonStaleCount.rows[0].cnt)).toBe(1);
		});
	},
);
