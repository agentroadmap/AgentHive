/**
 * P1124: D4 Validator Tests
 *
 * Tests the REAL module exports (parseVerificationLines, isPsqlSafe,
 * tokenizeSafeArgv, computeVerdict, validateProposal) — no local copies of
 * the logic under test.
 *
 * Coverage:
 * - Verification: line parser (malformed, multiple, missing)
 * - psql SELECT-only safety filter (injection attempts, comments, case tricks)
 * - subprocess argv vetting (git_log / ls / systemctl injection attempts)
 * - Verdict mapping (advance / hold / inconclusive — never auto-reject)
 * - No-auto-transition property + log-write semantics (live-DB, env-gated)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../../infra/postgres/pool.ts";
import {
	computeVerdict,
	isPsqlSafe,
	parseVerificationLines,
	tokenizeSafeArgv,
	validateProposal,
} from "../d4-validator.ts";

// Live-DB tests are env-gated; they also need AGENTHIVE_ALLOW_LIVE_DB=1 for
// the pool guard.
const skipIfNoLiveDb = process.env.AGENTHIVE_LIVE_DB_TESTS ? test : test.skip;

describe("d4-validator", () => {
	describe("Verification: line parser", () => {
		test("parses a psql verification line", () => {
			const specs = parseVerificationLines(
				"Some criterion. Verification: psql SELECT COUNT(*) FROM roadmap_proposal.proposal",
			);
			assert.equal(specs.length, 1);
			assert.equal(specs[0].command_type, "psql");
			assert.ok(specs[0].command_text.includes("SELECT COUNT"));
		});

		test("parses git_log / ls / systemctl_status lines", () => {
			for (const [line, type] of [
				["Verification: git_log git log --oneline -n 5", "git_log"],
				["Verification: ls ls -la /data/code/AgentHive", "ls"],
				["Verification: systemctl_status systemctl status pgbouncer", "systemctl_status"],
			] as const) {
				const specs = parseVerificationLines(line);
				assert.equal(specs.length, 1, line);
				assert.equal(specs[0].command_type, type);
			}
		});

		test("parses MULTIPLE Verification: lines in one criterion", () => {
			const specs = parseVerificationLines(
				`AC text.
Verification: psql SELECT 1
More prose.
Verification: ls ls /tmp`,
			);
			assert.equal(specs.length, 2);
			assert.equal(specs[0].command_type, "psql");
			assert.equal(specs[1].command_type, "ls");
		});

		test("returns [] for criterion with no Verification: line", () => {
			assert.deepEqual(parseVerificationLines("Just prose, no commands."), []);
		});

		test("drops a Verification: line with type but no command", () => {
			assert.deepEqual(parseVerificationLines("Verification: psql"), []);
		});

		test("is case-insensitive on the Verification: keyword", () => {
			const specs = parseVerificationLines("verification: psql SELECT 1");
			assert.equal(specs.length, 1);
		});
	});

	describe("psql SELECT-only safety filter", () => {
		test("accepts plain SELECT and WITH...SELECT", () => {
			assert.ok(isPsqlSafe("SELECT * FROM roadmap_proposal.proposal"));
			assert.ok(isPsqlSafe("select count(*) from t"));
			assert.ok(isPsqlSafe("/* comment */ SELECT 1"));
			assert.ok(isPsqlSafe("WITH cte AS (SELECT 1) SELECT * FROM cte"));
		});

		test("rejects mutating statements", () => {
			for (const cmd of [
				"INSERT INTO t VALUES (1)",
				"UPDATE t SET col=1",
				"DELETE FROM t",
				"DROP TABLE t",
				"TRUNCATE t",
				"ALTER TABLE t ADD COLUMN c INT",
				"CREATE TABLE t (c INT)",
				"COPY t FROM stdin",
				"DO $$ BEGIN END $$",
				"CALL f()",
				"GRANT ALL ON t TO public",
				"SHOW max_connections",
			]) {
				assert.ok(!isPsqlSafe(cmd), `should reject: ${cmd}`);
			}
		});

		test("rejects injection via chaining, CTE writes, and case tricks", () => {
			for (const cmd of [
				"SELECT 1; DROP TABLE x",
				"SELECT 1; drop table x",
				"/* harmless */ DELETE FROM t",
				"WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte",
				"select 1; UpDaTe t set c=1",
				"SELECT pg_sleep(60)",
				"SET role postgres",
			]) {
				assert.ok(!isPsqlSafe(cmd), `should reject: ${cmd}`);
			}
		});
	});

	describe("subprocess argv vetting (hostile criterion_text)", () => {
		test("accepts clean argv", () => {
			assert.deepEqual(tokenizeSafeArgv("git log --oneline -n 5"), [
				"git",
				"log",
				"--oneline",
				"-n",
				"5",
			]);
		});

		test("rejects any token with shell metacharacters", () => {
			for (const cmd of [
				"git log; rm -rf /tmp/x",
				"git log $(whoami)",
				"git log `id`",
				"git log | tee /etc/passwd",
				"git log --pretty=format:'%h'",
				"ls /tmp; rm -rf /",
				"ls $(whoami)",
				"ls > /tmp/out",
				"ls {a,b}",
				'git log "quoted"',
			]) {
				assert.equal(tokenizeSafeArgv(cmd), null, `should reject: ${cmd}`);
			}
		});

		test("rejects empty command", () => {
			assert.equal(tokenizeSafeArgv("   "), null);
		});
	});

	describe("verdict mapping (review 4363 point 5)", () => {
		test("advance when nothing failed and nothing inconclusive", () => {
			assert.equal(computeVerdict([], []).decision, "advance");
		});

		test("hold when any AC failed", () => {
			const verdict = computeVerdict([2], []);
			assert.equal(verdict.decision, "hold");
			assert.ok(verdict.rationale.includes("2"));
		});

		test("INCONCLUSIVE (never reject) when ACs are unverifiable", () => {
			const verdict = computeVerdict([], [3]);
			assert.equal(verdict.decision, "inconclusive");
			assert.ok(verdict.rationale.includes("falling through"));
		});

		test("failures take precedence over inconclusive", () => {
			assert.equal(computeVerdict([1], [2]).decision, "hold");
		});
	});

	describe("live-DB integration (AGENTHIVE_LIVE_DB_TESTS=1)", () => {
		async function createTestProposal(suffix: string): Promise<number> {
			const created = await query(
				`INSERT INTO roadmap_proposal.proposal
				 (display_id, type, status, title, project_id, audit)
				 VALUES ($1, 'feature', 'DEVELOP', $2, 1, '{}'::jsonb)
				 RETURNING id`,
				[`test-p1124-${suffix}-${process.pid}`, "p1124 validator test"],
			);
			return created.rows[0].id;
		}

		skipIfNoLiveDb("does not update proposal.status; writes D4 log for advance", async () => {
			const proposal_id = await createTestProposal("noop");
			try {
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, $2, 'pending', 1)`,
					[proposal_id, "Check something. Verification: psql SELECT 1"],
				);

				const before = await query(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposal_id],
				);
				const result = await validateProposal(proposal_id, undefined, true);
				assert.equal(result.decision, "advance");

				const after = await query(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposal_id],
				);
				assert.equal(after.rows[0].status, before.rows[0].status, "status must not change");

				const logRows = await query(
					`SELECT decided_by, decision, from_state, to_state
					 FROM roadmap_proposal.gate_decision_log
					 WHERE proposal_id = $1 AND gate = 'D4'`,
					[proposal_id],
				);
				assert.equal(logRows.rows.length, 1);
				assert.equal(logRows.rows[0].decided_by, "system/d4-validator");
				assert.equal(logRows.rows[0].from_state, logRows.rows[0].to_state, "filter, not a transition");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});

		skipIfNoLiveDb("inconclusive (no log row) for AC without Verification: line", async () => {
			const proposal_id = await createTestProposal("noverif");
			try {
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, 'Some criterion with no verification line', 'pending', 1)`,
					[proposal_id],
				);
				const result = await validateProposal(proposal_id, undefined, true);
				assert.equal(result.decision, "inconclusive");
				assert.ok(result.blockers.includes(1));

				const logRows = await query(
					`SELECT id FROM roadmap_proposal.gate_decision_log
					 WHERE proposal_id = $1 AND gate = 'D4'`,
					[proposal_id],
				);
				assert.equal(logRows.rows.length, 0, "inconclusive must not write a gate decision");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});

		skipIfNoLiveDb("inconclusive for proposal with no ACs", async () => {
			const proposal_id = await createTestProposal("noac");
			try {
				const result = await validateProposal(proposal_id, undefined, true);
				assert.equal(result.decision, "inconclusive");
				assert.equal(result.rationale, "No acceptance criteria found for proposal");
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});

		skipIfNoLiveDb("reuses a fresh verdict unless force_re_run", async () => {
			const proposal_id = await createTestProposal("cache");
			try {
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, $2, 'pending', 1)`,
					[proposal_id, "Check. Verification: psql SELECT 1"],
				);
				const first = await validateProposal(proposal_id, undefined, true);
				assert.equal(first.decision, "advance");
				const second = await validateProposal(proposal_id);
				assert.ok(second.rationale.startsWith("(cached"), "second run should reuse the verdict");
				assert.equal(second.log_id, first.log_id);
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});

		skipIfNoLiveDb("hold when a verification command fails", async () => {
			const proposal_id = await createTestProposal("hold");
			try {
				await query(
					`INSERT INTO roadmap_proposal.proposal_acceptance_criteria
					 (proposal_id, item_number, criterion_text, status, project_id)
					 VALUES ($1, 1, $2, 'pending', 1)`,
					[proposal_id, "Check. Verification: psql SELECT * FROM nonexistent_table_p1124"],
				);
				const result = await validateProposal(proposal_id, undefined, true);
				assert.equal(result.decision, "hold");
				assert.ok(result.challenges.includes(1));
			} finally {
				await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposal_id]);
			}
		});
	});
});
