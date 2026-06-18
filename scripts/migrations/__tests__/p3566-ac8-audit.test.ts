import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, before, after } from "node:test";

/**
 * P3566 AC-8 — gate-advance integrity audit surface (migration 298).
 *
 * AC-8: an idempotent, ledger-recorded migration adds a view/query surfacing
 * historical non-terminal advances that occurred via self-approve (advancer ==
 * sole approver) or over a newer blocking review (e.g. P3535), for audit only —
 * it does NOT reopen or alter those proposals.
 *
 * Text-scan tests always run. The DB fixture test is gated behind
 * AGENTHIVE_RESOLVER_DB_TEST=1 against a throwaway DB and runs inside a ROLLBACK.
 *
 * Run (DB):
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive_p3566_test \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3566-ac8-audit.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";
const TEST_DB = process.env.PGDATABASE || "agenthive_p3566_test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_298 = join(
	__dirname,
	"..",
	"298-p3566-gate-advance-integrity-audit.sql",
);

// ---------------------------------------------------------------------------
// Text-scan tests (always run, no DB)
// ---------------------------------------------------------------------------
describe("P3566 AC-8: audit migration structural invariants (text-scan)", () => {
	const sql = readFileSync(MIGRATION_298, "utf8");

	test("defines the audit view and the violations convenience view", () => {
		assert.match(
			sql,
			/CREATE OR REPLACE VIEW\s+roadmap_proposal\.v_gate_advance_integrity_audit/i,
		);
		assert.match(
			sql,
			/CREATE OR REPLACE VIEW\s+roadmap_proposal\.v_gate_advance_integrity_violations/i,
		);
	});

	test("sources status history (proposal_state_transitions), not gate_decision_log — so bare-approve advances are caught", () => {
		assert.match(
			sql,
			/FROM\s+roadmap_proposal\.proposal_state_transitions/i,
			"the audit must key off the status-transition history; advances that bypassed the gate log (e.g. P3535) are invisible to a gate_decision_log-only query",
		);
	});

	test("scopes to the non-terminal gates only", () => {
		assert.match(sql, /DRAFT→REVIEW/);
		assert.match(sql, /REVIEW→DEVELOP/);
		assert.doesNotMatch(
			sql,
			/IN \('DRAFT→REVIEW', 'REVIEW→DEVELOP', 'DEVELOP→MERGE'/,
			"terminal gates are P3563's surface, not this audit",
		);
	});

	test("flags self_approved, later_blocking_review, and missing gate_decision_log", () => {
		assert.match(sql, /\bAS\s+self_approved\b/i);
		assert.match(sql, /\bAS\s+later_blocking_review\b/i);
		assert.match(sql, /\bAS\s+has_gate_decision_log\b/i);
	});

	test("self-approve predicate compares reviewer_identity against the advancer", () => {
		assert.match(sql, /reviewer_identity\s+IS DISTINCT FROM\s+pst\.transitioned_by/i);
	});

	test("later-blocking predicate looks for blocking reviews AFTER the advance", () => {
		assert.match(sql, /pr\.is_blocking\s*=\s*true/i);
		assert.match(sql, /pr\.reviewed_at\s*>\s*pst\.transitioned_at/i);
	});

	test("is AUDIT ONLY — no mutation of proposals (no UPDATE/DELETE/ALTER on proposal tables)", () => {
		assert.doesNotMatch(sql, /\bUPDATE\s+roadmap_proposal\.proposal\b/i);
		assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+roadmap_proposal\./i);
		assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i);
	});

	test("idempotent (CREATE OR REPLACE; no bare CREATE VIEW that would fail on re-run)", () => {
		assert.doesNotMatch(sql, /CREATE VIEW\s+(?!OR REPLACE)/i);
	});
});

// ---------------------------------------------------------------------------
// DB fixture test (gated): seed a self-approve advance + a later blocking
// review, assert the violations view flags it; assert no rows were mutated.
// ---------------------------------------------------------------------------
describe("P3566 AC-8: audit view flags a seeded self-approve + later-blocking advance (DB)", { skip: !DB_TEST }, () => {
	let pg: any;
	let client: any;

	before(async () => {
		pg = await import("pg");
		client = new pg.Client({ database: TEST_DB });
		await client.connect();
		await client.query(readFileSync(MIGRATION_298, "utf8"));
	});

	after(async () => {
		if (client) await client.end();
	});

	test("seeded fixture appears in v_gate_advance_integrity_violations", async () => {
		await client.query("BEGIN");
		try {
			const pid = 990001;
			// A non-terminal advance by 'agent-x' at T0.
			await client.query(
				`INSERT INTO roadmap_proposal.proposal_state_transitions
				   (proposal_id, from_state, to_state, transitioned_by, transitioned_at)
				 VALUES ($1,'REVIEW','DEVELOP','agent-x', now() - interval '1 hour')`,
				[pid],
			);
			// Only approve before the advance is the advancer's own (self-approve).
			await client.query(
				`INSERT INTO roadmap_proposal.proposal_reviews
				   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at)
				 VALUES ($1,'agent-x','approve',false, now() - interval '61 minutes')`,
				[pid],
			);
			// A blocking review filed AFTER the advance (ignored TOCTOU tail).
			await client.query(
				`INSERT INTO roadmap_proposal.proposal_reviews
				   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at)
				 VALUES ($1,'agent-y','request_changes',true, now() - interval '30 minutes')`,
				[pid],
			);

			const { rows } = await client.query(
				`SELECT self_approved, later_blocking_review, has_gate_decision_log
				   FROM roadmap_proposal.v_gate_advance_integrity_violations
				  WHERE proposal_id = $1`,
				[pid],
			);
			assert.equal(rows.length, 1, "the seeded advance must be flagged as a violation");
			assert.equal(rows[0].self_approved, true);
			assert.equal(rows[0].later_blocking_review, true);
			assert.equal(rows[0].has_gate_decision_log, false);
		} finally {
			await client.query("ROLLBACK");
		}
	});

	test("a properly-reviewed advance (independent approve, no later blocking, logged) is NOT flagged", async () => {
		await client.query("BEGIN");
		try {
			const pid = 990002;
			await client.query(
				`INSERT INTO roadmap_proposal.proposal_state_transitions
				   (proposal_id, from_state, to_state, transitioned_by, transitioned_at)
				 VALUES ($1,'REVIEW','DEVELOP','agent-x', now() - interval '1 hour')`,
				[pid],
			);
			await client.query(
				`INSERT INTO roadmap_proposal.proposal_reviews
				   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at)
				 VALUES ($1,'agent-indep','approve',false, now() - interval '61 minutes')`,
				[pid],
			);
			await client.query(
				`INSERT INTO roadmap_proposal.gate_decision_log
				   (proposal_id, from_state, to_state, decided_by, decision, created_at)
				 VALUES ($1,'REVIEW','DEVELOP','agent-x','advance', now() - interval '1 hour')`,
				[pid],
			);
			const { rows } = await client.query(
				`SELECT 1 FROM roadmap_proposal.v_gate_advance_integrity_violations WHERE proposal_id = $1`,
				[pid],
			);
			assert.equal(rows.length, 0, "an independent, logged, unblocked advance is not a violation");
		} finally {
			await client.query("ROLLBACK");
		}
	});
});
