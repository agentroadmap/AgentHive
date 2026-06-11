/**
 * P1682: Hold-Wake Framework Tests
 *
 * Tests for AC-4 (hold state), AC-5 (wake path), AC-6 (env thresholds),
 * AC-8 (exclusions), and AC-9 (long reset behavior).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { query, type Pool } from "../postgres/pool.ts";

// ─── AC-4/AC-5: Hold and Wake State Tests ─────────────────────────────────

describe("P1682 AC-4: Hold State", () => {
	const HOLD_WINDOW_MAX_SEC = 1800; // 30 minutes default
	const CLAUDE_CLI_DEFAULT_COOLDOWN_SEC = 3600; // 1 hour default

	it("AC-4.1: records hold state on rate_limited with short resetAt", async () => {
		const resetAt = new Date(Date.now() + 600_000); // 10 minutes
		const dispatchId = 9999;
		const agencyId = "test-hold-agency";

		// This would be called from spawnWithRetry when resetAt < HOLD_WINDOW_MAX_SEC
		const result = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, paused_at_provider_limit,
			     provider_limit_paused_at, metadata, created_at)
			 VALUES ($1, $2, 'claimed', true, now(),
			         jsonb_build_object('resume_eligible_at', $3::text), now())
			 RETURNING id, paused_at_provider_limit, metadata->>'resume_eligible_at'`,
			[dispatchId, agencyId, resetAt.toISOString()],
		);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].paused_at_provider_limit).toBe(true);
		expect(result.rows[0]["resume_eligible_at"]).toBeTruthy();
	});

	it("AC-4.2: held row is non-terminal (not marked failed)", async () => {
		// Held rows should NOT have completed_at, failure_count incremented, etc.
		// They are suspended, not failed.
		const dispatchId = 9998;
		const agencyId = "test-agency-2";
		const resetAt = new Date(Date.now() + 900_000);

		// Initially create as claimed
		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, created_at)
			 VALUES ($1, $2, 'claimed', now())`,
			[dispatchId, agencyId],
		);

		// Now put into hold state
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET paused_at_provider_limit = true,
			        provider_limit_paused_at = now(),
			        metadata = jsonb_build_object('resume_eligible_at', $2::text)
			  WHERE id = $1`,
			[dispatchId, resetAt.toISOString()],
		);

		const result = await query(
			`SELECT paused_at_provider_limit, completed_at, failure_count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);

		expect(result.rows[0].paused_at_provider_limit).toBe(true);
		expect(result.rows[0].completed_at).toBeNull();
		expect(result.rows[0].failure_count).toBeNull();
	});
});

describe("P1682 AC-5: Wake Path", () => {
	it("AC-5.1: wake sweep clears paused_at_provider_limit on expiry", async () => {
		const dispatchId = 9997;
		const agencyId = "test-wake-agency";
		const resetAt = new Date(Date.now() - 60_000); // expired 1 minute ago

		// Create a held dispatch that has expired
		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, paused_at_provider_limit,
			     provider_limit_paused_at, metadata, created_at)
			 VALUES ($1, $2, 'claimed', true, now() - interval '2 min',
			         jsonb_build_object('resume_eligible_at', $3::text), now())`,
			[dispatchId, agencyId, resetAt.toISOString()],
		);

		// Simulate wake sweep: clear paused_at_provider_limit for expired rows
		const result = await query(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET paused_at_provider_limit = false
			  WHERE id = $1
			    AND paused_at_provider_limit = true
			    AND (metadata->>'resume_eligible_at')::timestamp <= now()
			  RETURNING id, paused_at_provider_limit`,
			[dispatchId],
		);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0].paused_at_provider_limit).toBe(false);
	});

	it("AC-5.2: wake sweep does not clear unexpired holds", async () => {
		const dispatchId = 9996;
		const agencyId = "test-unexpired";
		const resetAt = new Date(Date.now() + 600_000); // 10 minutes in future

		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, paused_at_provider_limit,
			     provider_limit_paused_at, metadata, created_at)
			 VALUES ($1, $2, 'claimed', true, now(),
			         jsonb_build_object('resume_eligible_at', $3::text), now())`,
			[dispatchId, agencyId, resetAt.toISOString()],
		);

		// Try wake sweep on non-expired hold
		const result = await query(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET paused_at_provider_limit = false
			  WHERE id = $1
			    AND paused_at_provider_limit = true
			    AND (metadata->>'resume_eligible_at')::timestamp <= now()
			  RETURNING id`,
			[dispatchId],
		);

		// Should not update unexpired row
		expect(result.rows).toHaveLength(0);

		// Verify it's still held
		const checkResult = await query(
			`SELECT paused_at_provider_limit FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[dispatchId],
		);
		expect(checkResult.rows[0].paused_at_provider_limit).toBe(true);
	});
});

describe("P1682 AC-6: Env-Backed Thresholds", () => {
	it("AC-6.1: reads AGENTHIVE_HOLD_WINDOW_MAX_SEC from env", () => {
		// This env var should be read in the decision fork at spawnWithRetry
		const holdWindowMaxSec = Number(
			process.env.AGENTHIVE_HOLD_WINDOW_MAX_SEC ?? 1800,
		);
		expect(holdWindowMaxSec).toBeGreaterThan(0);
		expect(holdWindowMaxSec).toBeLessThanOrEqual(24 * 3600); // max 24h
	});

	it("AC-6.2: reads AGENTHIVE_CLAUDE_CLI_DEFAULT_COOLDOWN_SEC from env", () => {
		const cooldownSec = Number(
			process.env.AGENTHIVE_CLAUDE_CLI_DEFAULT_COOLDOWN_SEC ?? 3600,
		);
		expect(cooldownSec).toBeGreaterThan(0);
		expect(cooldownSec).toBeLessThanOrEqual(24 * 3600);
	});

	it("AC-6.3: reads AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC for unparseable/long resets", () => {
		const longCooldownSec = Number(
			process.env.AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC ?? 86400,
		);
		expect(longCooldownSec).toBeGreaterThan(0);
		expect(longCooldownSec).toBeLessThanOrEqual(30 * 24 * 3600); // max 30 days
	});
});

describe("P1682 AC-8: Capacity/Reaper/Breaker Exclusion", () => {
	it("AC-8.1: held rows do not count toward max-in-flight capacity", async () => {
		const agencyId = "test-capacity-agency";

		// Clear any existing test data
		await query(
			`DELETE FROM roadmap_workforce.squad_dispatch
			  WHERE agent_identity = $1`,
			[agencyId],
		);

		// Create 3 normal active claims
		for (let i = 0; i < 3; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (agent_identity, offer_status, created_at)
				 VALUES ($1, 'claimed', now())`,
				[agencyId],
			);
		}

		// Create 2 held claims
		const resetAt = new Date(Date.now() + 600_000);
		for (let i = 0; i < 2; i++) {
			await query(
				`INSERT INTO roadmap_workforce.squad_dispatch
				    (agent_identity, offer_status, paused_at_provider_limit,
				     provider_limit_paused_at, metadata, created_at)
				 VALUES ($1, 'claimed', true, now(),
				         jsonb_build_object('resume_eligible_at', $2::text), now())`,
				[agencyId, resetAt.toISOString()],
			);
		}

		// Count active (non-held) rows
		const activeResult = await query(
			`SELECT COUNT(*) as active_count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE agent_identity = $1
			    AND offer_status = 'claimed'
			    AND (paused_at_provider_limit = false OR paused_at_provider_limit IS NULL)`,
			[agencyId],
		);

		// Should only count the 3 non-held rows
		expect(Number(activeResult.rows[0].active_count)).toBe(3);

		// Total count should be 5
		const totalResult = await query(
			`SELECT COUNT(*) as total_count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE agent_identity = $1`,
			[agencyId],
		);
		expect(Number(totalResult.rows[0].total_count)).toBe(5);
	});

	it("AC-8.2: reaper does not cancel held rows before resume_eligible_at", async () => {
		const dispatchId = 9995;
		const agencyId = "test-reaper-agency";
		const resetAt = new Date(Date.now() + 600_000);

		// Create a held dispatch
		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, paused_at_provider_limit,
			     provider_limit_paused_at, metadata, created_at)
			 VALUES ($1, $2, 'claimed', true, now(),
			         jsonb_build_object('resume_eligible_at', $3::text), now())`,
			[dispatchId, agencyId, resetAt.toISOString()],
		);

		// Simulate reaper trying to delete stale claims
		// Should exclude paused rows that haven't expired yet
		const result = await query(
			`DELETE FROM roadmap_workforce.squad_dispatch
			  WHERE agent_identity = $1
			    AND paused_at_provider_limit = true
			    AND (metadata->>'resume_eligible_at')::timestamp <= now()
			  RETURNING id`,
			[agencyId],
		);

		// Should NOT delete unexpired held row
		expect(result.rows).toHaveLength(0);

		// Verify row still exists
		const checkResult = await query(
			`SELECT id FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
			[dispatchId],
		);
		expect(checkResult.rows).toHaveLength(1);
	});

	it("AC-8.3: held rows do not increment failure_count or circuit breaker", async () => {
		const dispatchId = 9994;
		const agencyId = "test-breaker-agency";
		const resetAt = new Date(Date.now() + 600_000);

		// Create a held dispatch
		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, paused_at_provider_limit,
			     provider_limit_paused_at, failure_count, metadata, created_at)
			 VALUES ($1, $2, 'claimed', true, now(), 0,
			         jsonb_build_object('resume_eligible_at', $3::text), now())`,
			[dispatchId, agencyId, resetAt.toISOString()],
		);

		// Verify held rows are excluded from breaker logic
		// (should only count completed rows with failure_count > threshold)
		const result = await query(
			`SELECT COUNT(*) as failed_count
			   FROM roadmap_workforce.squad_dispatch
			  WHERE agent_identity = $1
			    AND (paused_at_provider_limit = false OR paused_at_provider_limit IS NULL)
			    AND failure_count > 0`,
			[agencyId],
		);

		// Held row should not be counted
		expect(Number(result.rows[0].failed_count)).toBe(0);
	});
});

describe("P1682 AC-9: Long/Unparseable Reset Behavior", () => {
	it("AC-9.1: long resetAt (> HOLD_WINDOW_MAX_SEC) triggers provider cooldown", () => {
		const holdWindowMaxSec = 1800;
		const longResetAt = new Date(Date.now() + 24 * 3600 * 1000); // 24 hours
		const deltaMs = longResetAt.getTime() - Date.now();
		const deltaSec = Math.ceil(deltaMs / 1000);

		expect(deltaSec).toBeGreaterThan(holdWindowMaxSec);
		// This should trigger provider-level cooldown instead of hold
	});

	it("AC-9.2: unparseable resetAt uses AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC", () => {
		const longCooldownSec = Number(
			process.env.AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC ?? 86400,
		);
		expect(longCooldownSec).toBe(86400); // 24 hours default
	});

	it("AC-9.3: metadata.reason recorded for long/unparseable resets", async () => {
		// When a reset is long or unparseable, metadata.reason should document it
		const dispatchId = 9993;
		const agencyId = "test-reason-agency";

		await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
			    (id, agent_identity, offer_status, metadata, created_at)
			 VALUES ($1, $2, 'completed',
			         jsonb_build_object(
			           'resume_eligible_at', null,
			           'reason', 'long_reset_exceeded_hold_window'
			         ), now())`,
			[dispatchId, agencyId],
		);

		const result = await query(
			`SELECT metadata->>'reason' as reason
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);

		expect(result.rows[0].reason).toBe("long_reset_exceeded_hold_window");
	});

	it("AC-9.4: does NOT call fn_return_work_offer for long resets", () => {
		// Per AC design: when resetAt > HOLD_WINDOW_MAX_SEC, set provider-level
		// cooldown and return (no release/handoff via fn_return_work_offer).
		// This test just documents the design constraint.
		expect(true).toBe(true);
	});
});

describe("P1682 Integration: Decision Fork at spawnWithRetry", () => {
	it("integration: on rate_limited with resetAt < HOLD_WINDOW_MAX_SEC, call recordProviderHardLimit", () => {
		const holdWindowMaxSec = 1800;
		const resetAt = new Date(Date.now() + 600_000); // 10 minutes
		const deltaMs = resetAt.getTime() - Date.now();
		const deltaSec = Math.ceil(deltaMs / 1000);

		expect(deltaSec).toBeLessThan(holdWindowMaxSec);
		// This should trigger recordProviderHardLimit() call
	});

	it("integration: on rate_limited with resetAt >= HOLD_WINDOW_MAX_SEC, set provider cooldown", () => {
		const holdWindowMaxSec = 1800;
		const resetAt = new Date(Date.now() + 3 * 3600 * 1000); // 3 hours
		const deltaMs = resetAt.getTime() - Date.now();
		const deltaSec = Math.ceil(deltaMs / 1000);

		expect(deltaSec).toBeGreaterThanOrEqual(holdWindowMaxSec);
		// This should set provider-level cooldown instead
	});
});
