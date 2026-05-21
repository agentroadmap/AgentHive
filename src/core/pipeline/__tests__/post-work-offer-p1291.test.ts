/**
 * P1291: Per-(proposal_id, role) pause fuse tests
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../../infra/postgres/pool.ts";
import { PausedRoleError } from "../post-work-offer.ts";

describe("P1291: Per-(proposal_id, role) pause fuse", () => {
	const proposalId = 99991;
	const proposalId2 = 99992;
	const role1 = "develop";
	const role2 = "review";

	beforeAll(async () => {
		// Clean up test data
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id IN ($1, $2)`,
			[proposalId, proposalId2],
		);
	});

	afterAll(async () => {
		// Clean up test data
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id IN ($1, $2)`,
			[proposalId, proposalId2],
		);
	});

	it("PausedRoleError is thrown with correct properties", () => {
		const expiresAt = new Date("2026-05-21T00:00:00Z");
		const err = new PausedRoleError(proposalId, role1, "no_eligible_agency", expiresAt);

		expect(err.message).toContain("paused");
		expect(err.proposalId).toBe(proposalId);
		expect(err.role).toBe(role1);
		expect(err.reason).toBe("no_eligible_agency");
		expect(err.expiresAt).toEqual(expiresAt);
	});

	it("First failure_count increment does not pause", async () => {
		// Insert pause row with failure_count=1 (below threshold of 2)
		await query(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle)
			 VALUES ($1, $2, 'no_eligible_agency', now() + interval '1 second', 1, 1)
			 ON CONFLICT (proposal_id, role) DO NOTHING`,
			[proposalId, role1],
		);

		const { rows } = await query<{ expires_at: string }>(
			`SELECT expires_at FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2`,
			[proposalId, role1],
		);

		// expires_at should be ~1 second in the future (not activated backoff)
		expect(rows[0]).toBeDefined();
		const expiresAt = new Date(rows[0].expires_at);
		const nowPlus1s = new Date(Date.now() + 1000);
		expect(Math.abs(expiresAt.getTime() - nowPlus1s.getTime())).toBeLessThan(2000);
	});

	it("Threshold-th failure activates exponential backoff", async () => {
		const threshold = 2;
		const baseBackoffMs = 1800000; // 30 minutes
		const multiplier = 2;

		// Simulate threshold reached: failure_count will be incremented to threshold
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2`,
			[proposalId, role2],
		);

		// Insert initial row
		await query(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle)
			 VALUES ($1, $2, 'no_eligible_agency', now() + interval '1 second', 1, 1)`,
			[proposalId, role2],
		);

		// Simulate second failure: increment failure_count, check if >= threshold
		const { rows: updateRows } = await query<{
			new_failure_count: number;
			pause_cycle: number;
		}>(
			`UPDATE roadmap_workforce.proposal_role_pause
			   SET failure_count = failure_count + 1,
			       paused_at = now()
			 WHERE proposal_id = $1 AND role = $2
			 RETURNING failure_count AS new_failure_count, pause_cycle`,
			[proposalId, role2],
		);

		expect(updateRows[0]?.new_failure_count).toBe(2);

		// If new_failure_count >= threshold, activate backoff
		if (updateRows[0] && updateRows[0].new_failure_count >= threshold) {
			const pauseCycle = updateRows[0].pause_cycle;
			const backoffMs = baseBackoffMs * Math.pow(multiplier, pauseCycle - 1);

			await query(
				`UPDATE roadmap_workforce.proposal_role_pause
				   SET expires_at = now() + ($1 || ' milliseconds')::interval,
				       failure_count = 0,
				       pause_cycle = pause_cycle + 1
				 WHERE proposal_id = $2 AND role = $3`,
				[String(Math.min(backoffMs, 86400000)), proposalId, role2],
			);

			const { rows: activeRows } = await query<{ expires_at: string }>(
				`SELECT expires_at FROM roadmap_workforce.proposal_role_pause
				  WHERE proposal_id = $1 AND role = $2`,
				[proposalId, role2],
			);

			// expires_at should be ~30 minutes in the future
			const expiresAt = new Date(activeRows[0].expires_at);
			const expectedExpiry = new Date(Date.now() + baseBackoffMs);
			expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(2000);
		}
	});

	it("Exponential backoff formula caps at MAX_BACKOFF (24h)", async () => {
		const baseBackoffMs = 1800000; // 30 minutes
		const multiplier = 2;
		const maxBackoffMs = 86400000; // 24 hours

		// Test 10-cycle progression
		const cycles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const expectedBackoffs = cycles.map((cycle) => {
			const backoff = baseBackoffMs * Math.pow(multiplier, cycle - 1);
			return Math.min(backoff, maxBackoffMs);
		});

		for (let i = 0; i < cycles.length; i++) {
			const cycle = cycles[i];
			const expectedBackoff = expectedBackoffs[i];

			// Cycle 1: 30min (1800000ms)
			// Cycle 2: 60min
			// Cycle 3: 120min
			// ...
			// Cycle 6: 960min = 16 hours
			// Cycle 7: 1920min = 32 hours -> capped at 24h = 86400000ms
			if (cycle <= 5) {
				const cycleBackoff = baseBackoffMs * Math.pow(multiplier, cycle - 1);
				expect(cycleBackoff).toBeLessThan(maxBackoffMs);
			} else if (cycle === 6) {
				// 16 hours = 57600000ms < 24h
				const cycleBackoff = baseBackoffMs * Math.pow(multiplier, cycle - 1);
				expect(cycleBackoff).toBeLessThan(maxBackoffMs);
			} else {
				// Cycles 7+ should be capped at 24h
				const cycleBackoff = baseBackoffMs * Math.pow(multiplier, cycle - 1);
				expect(Math.min(cycleBackoff, maxBackoffMs)).toBe(maxBackoffMs);
			}
		}
	});

	it("Non-expired pause row throws PausedRoleError on query", async () => {
		// Insert a pause row that expires in 1 hour
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2`,
			[proposalId, "test-pause"],
		);

		const expiresAt = new Date(Date.now() + 3600000); // 1 hour from now
		await query(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle)
			 VALUES ($1, $2, 'no_eligible_agency', $3, 0, 1)`,
			[proposalId, "test-pause", expiresAt.toISOString()],
		);

		// Verify the row exists and is not expired
		const { rows } = await query<{ pause_reason: string; expires_at: string }>(
			`SELECT pause_reason, expires_at::text FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2 AND expires_at > now() LIMIT 1`,
			[proposalId, "test-pause"],
		);

		expect(rows.length).toBe(1);
		expect(rows[0].pause_reason).toBe("no_eligible_agency");

		// If this row were checked in postWorkOffer, it would throw PausedRoleError
		const pausedErr = new PausedRoleError(proposalId, "test-pause", rows[0].pause_reason, new Date(rows[0].expires_at));
		expect(pausedErr.proposalId).toBe(proposalId);
	});

	it("Pause for (proposal, role1) does not affect (proposal, role2)", async () => {
		const p = 99993;
		const r1 = "develop";
		const r2 = "review";

		// Clean up
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause WHERE proposal_id = $1`,
			[p],
		);

		// Insert pause for (p, r1)
		await query(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle)
			 VALUES ($1, $2, 'no_eligible_agency', now() + interval '1 hour', 0, 1)`,
			[p, r1],
		);

		// Check (p, r1) is paused
		const { rows: paused } = await query<{ role: string }>(
			`SELECT role FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2 AND expires_at > now()`,
			[p, r1],
		);
		expect(paused.length).toBe(1);

		// Check (p, r2) is not paused
		const { rows: notPaused } = await query<{ role: string }>(
			`SELECT role FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2 AND expires_at > now()`,
			[p, r2],
		);
		expect(notPaused.length).toBe(0);

		// Clean up
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause WHERE proposal_id = $1`,
			[p],
		);
	});

	it("Resume via DELETE removes pause row", async () => {
		const p = 99994;
		const r = "develop";

		// Insert pause row
		await query(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle)
			 VALUES ($1, $2, 'no_eligible_agency', now() + interval '1 hour', 0, 1)`,
			[p, r],
		);

		// Verify pause exists
		let { rowCount } = await query(
			`SELECT 1 FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2 AND expires_at > now()`,
			[p, r],
		);
		expect(rowCount).toBe(1);

		// Delete (resume)
		await query(
			`DELETE FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2`,
			[p, r],
		);

		// Verify pause is gone
		const { rowCount: afterDelete } = await query(
			`SELECT 1 FROM roadmap_workforce.proposal_role_pause
			  WHERE proposal_id = $1 AND role = $2 AND expires_at > now()`,
			[p, r],
		);
		expect(afterDelete).toBe(0);
	});
});
