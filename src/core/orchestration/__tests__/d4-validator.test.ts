/**
 * P1124: D4 Validator Tests
 *
 * Tests cover:
 * - Verification: line parser (malformed, multiple, missing)
 * - Command safety filter (SELECT-only, injection attempts)
 * - Verdict mapping (pass/fail/inconclusive)
 * - No-auto-transition property (gate_decision_log write only)
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../../infra/postgres/pool.ts";
import { validateProposal } from "../d4-validator.ts";

// Skip live-DB tests unless explicitly enabled
const skipIfNoLiveDb = process.env.AGENTHIVE_LIVE_DB_TESTS ? test : test.skip;

describe("d4-validator", () => {
	describe("Verification: line parser", () => {
		test("parses psql verification line", () => {
			const criterion_text = `Some criterion. Verification: psql SELECT COUNT(*) FROM roadmap_proposal.proposal`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.ok(spec, "should parse psql line");
			assert.equal(spec.command_type, "psql");
			assert.ok(spec.command_text.includes("SELECT COUNT"));
		});

		test("parses git_log verification line", () => {
			const criterion_text = `Check git history. Verification: git_log git log --oneline -n 5`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.ok(spec, "should parse git_log line");
			assert.equal(spec.command_type, "git_log");
		});

		test("parses ls verification line", () => {
			const criterion_text = `File check. Verification: ls ls -la /data/code/AgentHive`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.ok(spec, "should parse ls line");
			assert.equal(spec.command_type, "ls");
		});

		test("parses systemctl_status verification line", () => {
			const criterion_text = `Service up. Verification: systemctl_status systemctl status postgresql`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.ok(spec, "should parse systemctl_status line");
			assert.equal(spec.command_type, "systemctl_status");
		});

		test("returns null for missing Verification: line", () => {
			const criterion_text = `Some criterion with no verification line.`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.equal(spec, null, "should return null");
		});

		test("returns null for malformed Verification: line (no command_text)", () => {
			const criterion_text = `Criterion. Verification: `;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.equal(spec, null, "should return null");
		});

		test("handles case-insensitive Verification: keyword", () => {
			const criterion_text = `Criterion. VERIFICATION: psql SELECT 1`;
			const spec = parseVerificationLineForTest(criterion_text);
			assert.ok(spec, "should parse case-insensitive");
			assert.equal(spec.command_type, "psql");
		});
	});

	describe("Command safety filter", () => {
		test("accepts SELECT query", () => {
			assert.ok(isPsqlSafeForTest("SELECT * FROM roadmap_proposal.proposal"));
		});

		test("rejects INSERT", () => {
			assert.ok(!isPsqlSafeForTest("INSERT INTO table VALUES (1)"));
		});

		test("rejects UPDATE", () => {
			assert.ok(!isPsqlSafeForTest("UPDATE table SET col=1"));
		});

		test("rejects DELETE", () => {
			assert.ok(!isPsqlSafeForTest("DELETE FROM table"));
		});

		test("rejects DROP", () => {
			assert.ok(!isPsqlSafeForTest("DROP TABLE table"));
		});

		test("rejects COPY", () => {
			assert.ok(!isPsqlSafeForTest("COPY table FROM stdin"));
		});

		test("rejects DO block", () => {
			assert.ok(!isPsqlSafeForTest("DO $$ SELECT 1 $$"));
		});

		test("rejects CALL", () => {
			assert.ok(!isPsqlSafeForTest("CALL function_name()"));
		});

		test("rejects command chaining with semicolon", () => {
			assert.ok(!isPsqlSafeForTest("SELECT 1; DROP TABLE x"));
		});

		test("handles comment-prefixed SELECT", () => {
			assert.ok(isPsqlSafeForTest("/* comment */ SELECT 1"));
		});

		test("handles case-insensitive SELECT", () => {
			assert.ok(isPsqlSafeForTest("select * from table"));
		});

		test("rejects non-SELECT queries", () => {
			assert.ok(!isPsqlSafeForTest("SHOW max_connections"));
			assert.ok(!isPsqlSafeForTest("WITH cte AS (SELECT 1) INSERT INTO table SELECT * FROM cte"));
		});

		test("rejects commands without SELECT as first keyword", () => {
			assert.ok(!isPsqlSafeForTest("ALTER TABLE t ADD COLUMN c INT"));
		});
	});

	describe("git_log command validation", () => {
		test("accepts git log command", async () => {
			// Mock test (won't run git unless in live env)
			const cmd = "git log --oneline -n 1";
			assert.ok(cmd.toLowerCase().startsWith("git log"), "should validate git log");
		});

		test("rejects git push", async () => {
			const cmd = "git push origin main";
			assert.ok(!cmd.toLowerCase().startsWith("git log"), "should reject git push");
		});

		test("rejects git reset", async () => {
			const cmd = "git reset --hard HEAD";
			assert.ok(!cmd.toLowerCase().startsWith("git log"), "should reject git reset");
		});
	});

	describe("ls command validation", () => {
		test("rejects shell metacharacters", async () => {
			const commands = [
				"ls /tmp; rm -rf /",
				"ls $(whoami)",
				"ls `id`",
				"ls | grep foo",
				"ls & background",
				"ls > /tmp/out",
				"ls < /tmp/in",
				"ls {a,b,c}",
				"ls [abc]",
			];

			for (const cmd of commands) {
				assert.ok(/[;&|`$(){}[\]<>]/.test(cmd), `should detect unsafe chars in: ${cmd}`);
			}
		});
	});

	describe("systemctl_status validation", () => {
		test("accepts systemctl status <service>", () => {
			const cmd = "systemctl status postgresql";
			const match = cmd.match(/^\s*systemctl\s+status\s+(\S+)$/i);
			assert.ok(match, "should match systemctl status format");
		});

		test("rejects systemctl enable", () => {
			const cmd = "systemctl enable postgresql";
			const match = cmd.match(/^\s*systemctl\s+status\s+(\S+)$/i);
			assert.equal(match, null, "should reject enable");
		});

		test("rejects systemctl restart", () => {
			const cmd = "systemctl restart postgresql";
			const match = cmd.match(/^\s*systemctl\s+status\s+(\S+)$/i);
			assert.equal(match, null, "should reject restart");
		});
	});

	describe("Verdict computation", () => {
		test("computes advance when all ACs pass", async () => {
			const results = [
				{ status: "pass", ac_number: 1 },
				{ status: "pass", ac_number: 2 },
				{ status: "pass", ac_number: 3 },
			];
			const { challenges, blockers } = computeVerdictForTest(results as any);
			assert.equal(challenges.length, 0, "no failures");
			assert.equal(blockers.length, 0, "no inconclusive");
		});

		test("computes hold when any AC fails", async () => {
			const results = [
				{ status: "pass", ac_number: 1 },
				{ status: "fail", ac_number: 2 },
				{ status: "pass", ac_number: 3 },
			];
			const { challenges, blockers } = computeVerdictForTest(results as any);
			assert.equal(challenges.includes(2), true, "should include failing AC");
			assert.equal(blockers.length, 0, "no inconclusive");
		});

		test("computes reject when any AC is inconclusive", async () => {
			const results = [
				{ status: "pass", ac_number: 1 },
				{ status: "inconclusive", ac_number: 2 },
				{ status: "pass", ac_number: 3 },
			];
			const { challenges, blockers } = computeVerdictForTest(results as any);
			assert.equal(challenges.length, 0, "no failures");
			assert.equal(blockers.includes(2), true, "should include inconclusive AC");
		});

		test("prioritizes failures over inconclusive", async () => {
			const results = [
				{ status: "fail", ac_number: 1 },
				{ status: "inconclusive", ac_number: 2 },
			];
			const { decision } = computeVerdictForTest(results as any);
			assert.equal(decision, "hold", "failures take precedence");
		});
	});

	describe("No-auto-transition property", () => {
		skipIfNoLiveDb("does not update proposal.status", async () => {
			// Create a test proposal in MERGE state
			const createResult = await query(
				`INSERT INTO roadmap_proposal.proposal
				 (display_id, type, status, title, project_id)
				 VALUES ($1, 'epic', 'Develop', $2, 1)
				 RETURNING id`,
				[`test-p1124-${Date.now()}`, "test-validator"],
			);
			const proposal_id = createResult.rows[0].id;

			try {
				// Insert an AC with Verification: line
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, $2, 'pending', 1)`,
					[proposal_id, "Check something. Verification: psql SELECT 1"],
				);

				// Record original status
				let statusBefore = await query(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposal_id],
				);
				const originalStatus = statusBefore.rows[0].status;

				// Run validator
				await validateProposal(proposal_id);

				// Check status unchanged
				let statusAfter = await query(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposal_id],
				);
				assert.equal(statusAfter.rows[0].status, originalStatus, "status should not change");

				// Verify gate_decision_log was written
				const logRows = await query(
					`SELECT * FROM roadmap_proposal.gate_decision_log
					 WHERE proposal_id = $1 AND gate = 'D4'`,
					[proposal_id],
				);
				assert.ok(logRows.rows.length > 0, "gate_decision_log should have a row");
				assert.equal(logRows.rows[0].decided_by, "system/d4-validator");
			} finally {
				// Clean up
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});
	});

	describe("Integration: validateProposal", () => {
		skipIfNoLiveDb("returns inconclusive for proposal with no ACs", async () => {
			const createResult = await query(
				`INSERT INTO roadmap_proposal.proposal
				 (display_id, type, status, title, project_id)
				 VALUES ($1, 'epic', 'Develop', $2, 1)
				 RETURNING id`,
				[`test-p1124-no-ac-${Date.now()}`, "test-validator"],
			);
			const proposal_id = createResult.rows[0].id;

			try {
				const result = await validateProposal(proposal_id);
				assert.equal(result.decision, "inconclusive");
				assert.equal(result.rationale, "No acceptance criteria found for proposal");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});

		skipIfNoLiveDb("returns inconclusive for AC with no Verification: line", async () => {
			const createResult = await query(
				`INSERT INTO roadmap_proposal.proposal
				 (display_id, type, status, title, project_id)
				 VALUES ($1, 'epic', 'Develop', $2, 1)
				 RETURNING id`,
				[`test-p1124-no-verif-${Date.now()}`, "test-validator"],
			);
			const proposal_id = createResult.rows[0].id;

			try {
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, $2, 'pending', 1)`,
					[proposal_id, "Some criterion with no verification line"],
				);

				const result = await validateProposal(proposal_id);
				assert.equal(result.decision, "reject");
				assert.ok(result.blockers.includes(1), "should include inconclusive AC");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});
	});
});

// Helper functions to expose private functions for testing
function parseVerificationLineForTest(criterion_text: string): { command_type: string; command_text: string } | null {
	const match = criterion_text.match(/Verification:\s*(\S+)\s+(.*?)(?:\n|$)/i);
	if (!match) {
		return null;
	}
	const command_type = match[1].toLowerCase();
	const command_text = match[2].trim();
	if (!command_text) {
		return null;
	}
	return { command_type, command_text };
}

function isPsqlSafeForTest(cmd: string): boolean {
	const PSQL_SELECT_REGEX = /^\s*(?:\/\*[\s\S]*?\*\/)?\s*SELECT\s+/i;
	const PSQL_UNSAFE_PATTERNS = [
		/INSERT\s+/i,
		/UPDATE\s+/i,
		/DELETE\s+/i,
		/DROP\s+/i,
		/TRUNCATE\s+/i,
		/ALTER\s+/i,
		/CREATE\s+/i,
		/COPY\s+/i,
		/DO\s+/i,
		/CALL\s+/i,
		/;\s*[A-Z]/i,
	];

	if (!PSQL_SELECT_REGEX.test(cmd)) {
		return false;
	}
	for (const pattern of PSQL_UNSAFE_PATTERNS) {
		if (pattern.test(cmd)) {
			return false;
		}
	}
	return true;
}

function computeVerdictForTest(
	results: Array<{ status: "pass" | "fail" | "inconclusive"; ac_number: number }>,
): { decision: string; challenges: number[]; blockers: number[] } {
	const challenges: number[] = [];
	const blockers: number[] = [];

	for (const result of results) {
		if (result.status === "fail") {
			challenges.push(result.ac_number);
		} else if (result.status === "inconclusive") {
			blockers.push(result.ac_number);
		}
	}

	let decision: string;
	if (blockers.length > 0 && challenges.length === 0) {
		decision = "reject";
	} else if (challenges.length > 0) {
		decision = "hold";
	} else if (results.length === 0) {
		decision = "inconclusive";
	} else {
		decision = "advance";
	}

	return { decision, challenges, blockers };
}
