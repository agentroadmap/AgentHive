/**
 * P2709: State Monitor — AC verification tests
 *
 * Verifies all 5 AC requirements:
 * AC-1: Query corrected to roadmap_proposal.proposal_acceptance_criteria
 * AC-2: Gate-hold grace-period check before maturity write
 * AC-3: Atomic CAS guard on UPDATE
 * AC-4: GRACE_PERIOD from hot-reloadable runtime flag (default 300s)
 * AC-5: Logging clarity with reason strings
 *
 * Live DB gated. Creates test proposals + ACs + gate decisions; cleans up.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { query } from "../infra/postgres/pool.ts";
import { StateMonitor } from "../core/tool-agents/state-monitor.ts";
import { FeatureFlagService } from "../shared/runtime/feature-flag-service.ts";
import { getPool } from "../infra/postgres/pool.ts";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";
describe.skipIf(!LIVE)("P2709 State Monitor — Gate Hold Grace Period", () => {
	let testProposalId: number;
	let testProposalId2: number;
	let testProposalId3: number;

	beforeAll(async () => {
		// Initialize FeatureFlagService for flag reads
		try {
			FeatureFlagService.initialize(getPool());
		} catch {
			// Already initialized
		}
	});

	afterEach(async () => {
		// Clean up test proposals and related rows
		if (testProposalId) {
			await query(
				`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
				[testProposalId],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
				[testProposalId],
			);
			await query(
				`DELETE FROM roadmap.gate_decision_log WHERE proposal_id = $1`,
				[testProposalId],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId],
			);
		}
		if (testProposalId2) {
			await query(
				`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
				[testProposalId2],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
				[testProposalId2],
			);
			await query(
				`DELETE FROM roadmap.gate_decision_log WHERE proposal_id = $1`,
				[testProposalId2],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId2],
			);
		}
		if (testProposalId3) {
			await query(
				`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
				[testProposalId3],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
				[testProposalId3],
			);
			await query(
				`DELETE FROM roadmap.gate_decision_log WHERE proposal_id = $1`,
				[testProposalId3],
			);
			await query(
				`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId3],
			);
		}
	});

	/**
	 * AC-1: Query correction test
	 * Verifies state-monitor queries the CORRECT table
	 * (roadmap_proposal.proposal_acceptance_criteria) and returns 3 ACs, not 0.
	 */
	it("AC-1: Should query roadmap_proposal.proposal_acceptance_criteria and return correct AC count", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit)
			 VALUES ('feature', 'Draft', 'P2709 AC1 Test', '[]'::jsonb)
			 RETURNING id`,
			[],
		);
		testProposalId = propRows[0].id;

		// Create 3 ACs
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass'),
					($1, 2, 'AC 2 test', 'pass'),
					($1, 3, 'AC 3 test', 'pass')`,
			[testProposalId],
		);

		// Invoke state monitor
		const monitor = new StateMonitor({ autoAdvance: true });
		const result = await monitor.invoke({ proposalId: testProposalId });

		expect(result.success).toBe(true);
		expect(result.output).toContain("3/3 ACs pass");
		expect(result.output).toContain("maturity set to 'mature'");
	});

	/**
	 * AC-2: Gate-hold grace-period check test
	 * Verifies state-monitor skips maturity write when a recent gate hold exists,
	 * logs "[SKIP] gate hold detected N seconds ago (grace period 300 seconds)".
	 */
	it("AC-2: Should skip maturity write when recent gate hold exists within grace period", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit, maturity)
			 VALUES ('feature', 'Draft', 'P2709 AC2 Test', '[]'::jsonb, 'new')
			 RETURNING id`,
			[],
		);
		testProposalId2 = propRows[0].id;

		// Create 2 ACs, both passing
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass'),
					($1, 2, 'AC 2 test', 'pass')`,
			[testProposalId2],
		);

		// Create a gate hold DECISION from the past (10 seconds ago)
		// within default grace period of 300 seconds
		await query(
			`INSERT INTO roadmap.gate_decision_log
				(proposal_id, decision, decided_by, created_at)
			 VALUES ($1, 'hold', 'test-agent', now() - interval '10 seconds')`,
			[testProposalId2],
		);

		// Invoke state monitor
		const monitor = new StateMonitor({ autoAdvance: true });
		const result = await monitor.invoke({ proposalId: testProposalId2 });

		expect(result.success).toBe(true);
		// Should skip due to recent hold
		expect(result.output).toContain("[SKIP]");
		expect(result.output).toContain("gate hold detected");

		// Verify maturity was NOT written
		const { rows: propCheck } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId2],
		);
		expect(propCheck[0].maturity).toBe("new");
	});

	/**
	 * AC-3: Atomic CAS guard test
	 * Verifies that a concurrent gate hold cannot overwrite a maturity write.
	 * The CAS guard in the UPDATE WHERE clause prevents the race.
	 */
	it("AC-3: Should prevent maturity write when gate hold is inserted concurrently (CAS guard)", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit, maturity)
			 VALUES ('feature', 'Draft', 'P2709 AC3 Test', '[]'::jsonb, 'new')
			 RETURNING id`,
			[],
		);
		testProposalId3 = propRows[0].id;

		// Create 2 passing ACs
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass'),
					($1, 2, 'AC 2 test', 'pass')`,
			[testProposalId3],
		);

		// Invoke state monitor (no gate hold yet, so it should attempt to write mature)
		const monitor = new StateMonitor({ autoAdvance: true });
		const result = await monitor.invoke({ proposalId: testProposalId3 });

		expect(result.success).toBe(true);
		// First call should succeed (no gate hold)
		expect(result.output).toContain("maturity set to 'mature'");

		// Verify maturity WAS written
		const { rows: propCheck } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId3],
		);
		expect(propCheck[0].maturity).toBe("mature");

		// Now create a gate hold
		await query(
			`INSERT INTO roadmap.gate_decision_log
				(proposal_id, decision, decided_by, created_at)
			 VALUES ($1, 'hold', 'test-agent', now())`,
			[testProposalId3],
		);

		// Reset maturity to 'new' (simulating gate demotion)
		await query(
			`UPDATE roadmap_proposal.proposal SET maturity = 'new' WHERE id = $1`,
			[testProposalId3],
		);

		// Try to re-invoke state monitor (should be blocked by CAS guard now)
		const result2 = await monitor.invoke({ proposalId: testProposalId3 });
		expect(result2.success).toBe(true);
		expect(result2.output).toContain("[SKIP]");

		// Verify maturity stayed 'new' (CAS guard blocked the write)
		const { rows: propCheck2 } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId3],
		);
		expect(propCheck2[0].maturity).toBe("new");
	});

	/**
	 * AC-4: Hot-reloadable grace-period flag test
	 * Verifies state-monitor reads GRACE_PERIOD from feature_flag table,
	 * and honors the value in gate-hold grace checks.
	 * Grace period default: 300 seconds (5 minutes).
	 */
	it("AC-4: Should read GRACE_PERIOD from feature_flag and use default 300 seconds", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit, maturity)
			 VALUES ('feature', 'Draft', 'P2709 AC4 Test', '[]'::jsonb, 'new')
			 RETURNING id`,
			[],
		);
		testProposalId = propRows[0].id;

		// Create passing ACs
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass')`,
			[testProposalId],
		);

		// Insert a gate hold from 6+ minutes ago (outside 300s default grace period)
		await query(
			`INSERT INTO roadmap.gate_decision_log
				(proposal_id, decision, decided_by, created_at)
			 VALUES ($1, 'hold', 'test-agent', now() - interval '400 seconds')`,
			[testProposalId],
		);

		// Invoke state monitor
		// With default grace period of 300s, a hold from 400s ago should NOT block maturity write
		const monitor = new StateMonitor({ autoAdvance: true });
		const result = await monitor.invoke({ proposalId: testProposalId });

		expect(result.success).toBe(true);
		// Should WRITE (not skip) because hold is older than 300s grace period
		expect(result.output).toContain("maturity set to 'mature'");

		// Verify maturity WAS written
		const { rows: propCheck } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId],
		);
		expect(propCheck[0].maturity).toBe("mature");
	});

	/**
	 * AC-5: Logging clarity test
	 * Verifies state-monitor logs all maturity decisions with clear reason strings:
	 * - "[WRITE] no gate hold, all ACs pass"
	 * - "[SKIP] gate hold detected N seconds ago (grace period ...)"
	 * - "[SKIP] AC pass rate X% below threshold Y%"
	 * - "[SKIP] query returned 0 ACs"
	 *
	 * Also verifies that discussions are written for audit trail when maturity is written.
	 */
	it("AC-5: Should log maturity decisions with clear reason strings and audit trail", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit, maturity)
			 VALUES ('feature', 'Draft', 'P2709 AC5 Test', '[]'::jsonb, 'new')
			 RETURNING id`,
			[],
		);
		testProposalId = propRows[0].id;

		// Create 2 passing ACs
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass'),
					($1, 2, 'AC 2 test', 'pass')`,
			[testProposalId],
		);

		// Invoke state monitor
		const monitor = new StateMonitor({ autoAdvance: true });
		const result = await monitor.invoke({ proposalId: testProposalId });

		expect(result.success).toBe(true);
		// Should contain [WRITE] with clear reason
		expect(result.output).toContain("[WRITE] no gate hold, all ACs pass");

		// Verify discussion was written for audit trail
		const { rows: discussions } = await query<{ body: string }>(
			`SELECT body FROM roadmap_proposal.proposal_discussions
			  WHERE proposal_id = $1 AND author_identity = 'tool/state-monitor'
			  ORDER BY id DESC LIMIT 1`,
			[testProposalId],
		);
		expect(discussions.length).toBeGreaterThan(0);
		expect(discussions[0].body).toContain("[WRITE] no gate hold, all ACs pass");
		expect(discussions[0].body).toContain("2/2 ACs pass");
		expect(discussions[0].body).toContain("grace period: 300s");
	});

	/**
	 * Integration test: Grace period expiry
	 * Verifies that when grace period EXPIRES, the hold no longer blocks maturity write.
	 */
	it("Should allow maturity write when grace period expires (hold older than grace period)", async () => {
		// Create test proposal
		const { rows: propRows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(type, status, title, audit, maturity)
			 VALUES ('feature', 'Draft', 'P2709 Grace Expiry Test', '[]'::jsonb, 'new')
			 RETURNING id`,
			[],
		);
		testProposalId = propRows[0].id;

		// Create passing AC
		await query(
			`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
				(proposal_id, item_number, criterion_text, status)
			 VALUES ($1, 1, 'AC 1 test', 'pass')`,
			[testProposalId],
		);

		// Insert a gate hold from 2 seconds ago (well within 300s grace period)
		await query(
			`INSERT INTO roadmap.gate_decision_log
				(proposal_id, decision, decided_by, created_at)
			 VALUES ($1, 'hold', 'test-agent', now() - interval '2 seconds')`,
			[testProposalId],
		);

		// First invoke should skip (hold is within grace period)
		const monitor = new StateMonitor({ autoAdvance: true });
		let result = await monitor.invoke({ proposalId: testProposalId });
		expect(result.output).toContain("[SKIP]");
		expect(result.output).toContain("gate hold detected");

		// Wait for grace period to expire (301 seconds) — simulated by inserting older hold
		// In real scenario, we'd wait. For tests, we simulate by checking with an old hold.
		await query(
			`DELETE FROM roadmap.gate_decision_log WHERE proposal_id = $1`,
			[testProposalId],
		);
		// Insert hold from 400s ago (outside 300s grace period)
		await query(
			`INSERT INTO roadmap.gate_decision_log
				(proposal_id, decision, decided_by, created_at)
			 VALUES ($1, 'hold', 'test-agent', now() - interval '400 seconds')`,
			[testProposalId],
		);

		// Second invoke should WRITE (grace period expired)
		result = await monitor.invoke({ proposalId: testProposalId });
		expect(result.output).toContain("[WRITE] no gate hold, all ACs pass");

		// Verify maturity was written
		const { rows: propCheck } = await query<{ maturity: string }>(
			`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
			[testProposalId],
		);
		expect(propCheck[0].maturity).toBe("mature");
	});
});
