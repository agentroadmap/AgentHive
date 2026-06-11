/**
 * P2709 State Monitor test — standalone runner (not vitest)
 * Tests all 5 AC requirements for state-monitor fix.
 */

import { query, getPool } from "./src/infra/postgres/pool.ts";
import { StateMonitor } from "./src/core/tool-agents/state-monitor.ts";

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

const results: TestResult[] = [];

async function test(
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		console.log(`\n[TEST] ${name}...`);
		await fn();
		console.log(`  ✓ PASSED`);
		results.push({ name, passed: true });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.log(`  ✗ FAILED: ${msg}`);
		results.push({ name, passed: false, error: msg });
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

async function cleanup(proposalId: number): Promise<void> {
	if (!proposalId) return;
	try {
		await query(
			`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
			[proposalId],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal_acceptance_criteria WHERE proposal_id = $1`,
			[proposalId],
		);
		await query(
			`DELETE FROM roadmap.gate_decision_log WHERE proposal_id = $1`,
			[proposalId],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal WHERE id = $1`,
			[proposalId],
		);
	} catch {
		// ignore cleanup errors
	}
}

async function main(): Promise<void> {
	console.log("=".repeat(60));
	console.log("P2709: State Monitor AC Verification Tests");
	console.log("=".repeat(60));

	const monitor = new StateMonitor({ autoAdvance: true });

	// AC-1: Query correction test
	let testProposalId1 = 0;
	await test(
		"AC-1: Query roadmap_proposal.proposal_acceptance_criteria (not nonexistent table)",
		async () => {
			const { rows: propRows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
					(type, status, title, audit)
				 VALUES ('feature', 'Draft', 'P2709 AC1 Test', '[]'::jsonb)
				 RETURNING id`,
			);
			testProposalId1 = propRows[0].id;

			// Create 3 ACs
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					(proposal_id, item_number, criterion_text, status)
				 VALUES ($1, 1, 'AC 1 test', 'pass'),
						($1, 2, 'AC 2 test', 'pass'),
						($1, 3, 'AC 3 test', 'pass')`,
				[testProposalId1],
			);

			// Invoke state monitor
			const result = await monitor.invoke({ proposalId: testProposalId1 });

			assert(
				result.output.includes("3/3 ACs pass"),
				`Expected "3/3 ACs pass" in output, got: ${result.output}`,
			);
			assert(
				result.output.includes("maturity set to 'mature'"),
				`Expected maturity write in output, got: ${result.output}`,
			);

			// Verify maturity was written
			const { rows: propCheck } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId1],
			);
			assert(
				propCheck[0].maturity === "mature",
				`Expected maturity='mature', got: ${propCheck[0].maturity}`,
			);
		},
	);
	await cleanup(testProposalId1);

	// AC-2: Gate-hold grace-period check test
	let testProposalId2 = 0;
	await test(
		"AC-2: Skip maturity write when recent gate hold exists",
		async () => {
			const { rows: propRows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
					(type, status, title, audit, maturity)
				 VALUES ('feature', 'Draft', 'P2709 AC2 Test', '[]'::jsonb, 'new')
				 RETURNING id`,
			);
			testProposalId2 = propRows[0].id;

			// Create 2 passing ACs
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					(proposal_id, item_number, criterion_text, status)
				 VALUES ($1, 1, 'AC 1 test', 'pass'),
						($1, 2, 'AC 2 test', 'pass')`,
				[testProposalId2],
			);

			// Create a gate hold from 10 seconds ago (within 300s grace period)
			await query(
				`INSERT INTO roadmap.gate_decision_log
					(proposal_id, from_state, to_state, decision, decided_by, created_at)
				 VALUES ($1, 'REVIEW', 'REVIEW', 'hold', 'tool/state-monitor-test', now() - interval '10 seconds')`,
				[testProposalId2],
			);

			// Invoke state monitor
			const result = await monitor.invoke({ proposalId: testProposalId2 });

			assert(
				result.output.includes("[SKIP]"),
				`Expected [SKIP] in output, got: ${result.output}`,
			);
			assert(
				result.output.includes("gate hold detected"),
				`Expected "gate hold detected" in output, got: ${result.output}`,
			);

			// Verify maturity was NOT written
			const { rows: propCheck } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId2],
			);
			assert(
				propCheck[0].maturity === "new",
				`Expected maturity='new' (unchanged), got: ${propCheck[0].maturity}`,
			);
		},
	);
	await cleanup(testProposalId2);

	// AC-3: Atomic CAS guard test
	let testProposalId3 = 0;
	await test(
		"AC-3: CAS guard prevents maturity write when concurrent gate hold exists",
		async () => {
			const { rows: propRows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
					(type, status, title, audit, maturity)
				 VALUES ('feature', 'Draft', 'P2709 AC3 Test', '[]'::jsonb, 'new')
				 RETURNING id`,
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

			// First invoke (no hold, should succeed)
			let result = await monitor.invoke({ proposalId: testProposalId3 });
			assert(
				result.output.includes("maturity set to 'mature'"),
				`First invoke should write maturity, got: ${result.output}`,
			);

			// Create a gate hold
			await query(
				`INSERT INTO roadmap.gate_decision_log
					(proposal_id, from_state, to_state, decision, decided_by, created_at)
				 VALUES ($1, 'REVIEW', 'REVIEW', 'hold', 'tool/state-monitor-test', now())`,
				[testProposalId3],
			);

			// Reset maturity to 'new'
			await query(
				`UPDATE roadmap_proposal.proposal SET maturity = 'new' WHERE id = $1`,
				[testProposalId3],
			);

			// Second invoke should be blocked by CAS guard
			result = await monitor.invoke({ proposalId: testProposalId3 });
			assert(
				result.output.includes("[SKIP]"),
				`Second invoke should skip due to CAS guard, got: ${result.output}`,
			);

			// Verify maturity stayed 'new'
			const { rows: propCheck } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId3],
			);
			assert(
				propCheck[0].maturity === "new",
				`Expected maturity='new' after CAS block, got: ${propCheck[0].maturity}`,
			);
		},
	);
	await cleanup(testProposalId3);

	// AC-4: Grace period expiry test
	let testProposalId4 = 0;
	await test(
		"AC-4: Grace period default (300s) allows maturity write when hold expires",
		async () => {
			const { rows: propRows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
					(type, status, title, audit, maturity)
				 VALUES ('feature', 'Draft', 'P2709 AC4 Test', '[]'::jsonb, 'new')
				 RETURNING id`,
			);
			testProposalId4 = propRows[0].id;

			// Create 1 passing AC
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					(proposal_id, item_number, criterion_text, status)
				 VALUES ($1, 1, 'AC 1 test', 'pass')`,
				[testProposalId4],
			);

			// Insert hold from 400 seconds ago (outside 300s default grace period)
			await query(
				`INSERT INTO roadmap.gate_decision_log
					(proposal_id, from_state, to_state, decision, decided_by, created_at)
				 VALUES ($1, 'REVIEW', 'REVIEW', 'hold', 'tool/state-monitor-test', now() - interval '400 seconds')`,
				[testProposalId4],
			);

			// Invoke state monitor
			// Hold is old enough, so maturity should write
			const result = await monitor.invoke({ proposalId: testProposalId4 });
			assert(
				result.output.includes("maturity set to 'mature'"),
				`Expected maturity write (grace period expired), got: ${result.output}`,
			);

			// Verify maturity was written
			const { rows: propCheck } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[testProposalId4],
			);
			assert(
				propCheck[0].maturity === "mature",
				`Expected maturity='mature', got: ${propCheck[0].maturity}`,
			);
		},
	);
	await cleanup(testProposalId4);

	// AC-5: Logging clarity test
	let testProposalId5 = 0;
	await test(
		"AC-5: Logs maturity decisions with clear reason strings and audit trail",
		async () => {
			const { rows: propRows } = await query<{ id: number }>(
				`INSERT INTO roadmap_proposal.proposal
					(type, status, title, audit, maturity)
				 VALUES ('feature', 'Draft', 'P2709 AC5 Test', '[]'::jsonb, 'new')
				 RETURNING id`,
			);
			testProposalId5 = propRows[0].id;

			// Create 2 passing ACs
			await query(
				`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					(proposal_id, item_number, criterion_text, status)
				 VALUES ($1, 1, 'AC 1 test', 'pass'),
						($1, 2, 'AC 2 test', 'pass')`,
				[testProposalId5],
			);

			// Invoke state monitor
			const result = await monitor.invoke({ proposalId: testProposalId5 });

			assert(
				result.output.includes("[WRITE] no gate hold, all ACs pass"),
				`Expected clear [WRITE] reason in output, got: ${result.output}`,
			);

			// Verify discussion was written for audit trail
			const { rows: discussions } = await query<{ body: string }>(
				`SELECT body FROM roadmap_proposal.proposal_discussions
				  WHERE proposal_id = $1 AND author_identity = 'tool/state-monitor'
				  ORDER BY id DESC LIMIT 1`,
				[testProposalId5],
			);
			assert(
				discussions.length > 0,
				"Expected discussion entry in audit trail",
			);
			assert(
				discussions[0].body.includes("[WRITE] no gate hold, all ACs pass"),
				`Expected reason string in discussion, got: ${discussions[0].body}`,
			);
			assert(
				discussions[0].body.includes("2/2 ACs pass"),
				`Expected AC count in discussion, got: ${discussions[0].body}`,
			);
			assert(
				discussions[0].body.includes("grace period: 300s"),
				`Expected grace period info in discussion, got: ${discussions[0].body}`,
			);
		},
	);
	await cleanup(testProposalId5);

	// Summary
	console.log("\n" + "=".repeat(60));
	console.log("TEST SUMMARY");
	console.log("=".repeat(60));

	const passed = results.filter((r) => r.passed).length;
	const total = results.length;

	results.forEach((r) => {
		const status = r.passed ? "✓" : "✗";
		console.log(`${status} ${r.name}`);
		if (r.error) {
			console.log(`  Error: ${r.error}`);
		}
	});

	console.log(`\nTotal: ${passed}/${total} tests passed`);

	if (passed === total) {
		console.log("\n🎉 All AC requirements verified!");
		process.exit(0);
	} else {
		console.log(`\n❌ ${total - passed} test(s) failed`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
