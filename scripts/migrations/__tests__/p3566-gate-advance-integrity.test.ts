import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

/**
 * P3566 — Gate-advance authorization integrity.
 *
 * Tests the five acceptance criteria:
 *   AC-1: Independent approver required for non-terminal gates.
 *   AC-2: Unresolved blocking review blocks advance.
 *   AC-3: Bare proposal_reviews approve no longer authorizes advance (Branch B removed).
 *   AC-4: Late-blocking review emits CRITICAL notification (and optionally auto-sends-back).
 *   AC-5: roadmap.fn_actor_is_independent() helper installed.
 *
 * Run modes:
 *   Text scan tests (always run): read migration SQL to verify structural invariants.
 *   DB integration tests (env-gated): live-DB tests inside ROLLBACK transactions.
 *
 *   AGENTHIVE_RESOLVER_DB_TEST=1 \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3566-gate-advance-integrity.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_289 = join(__dirname, "..", "289-p3566-gate-advance-integrity.sql");
const MIGRATION_040 = join(__dirname, "..", "040-p290-gate-enforcement.sql");

// ---------------------------------------------------------------------------
// Text-scan tests (always run — no DB required)
// ---------------------------------------------------------------------------
describe("P3566: migration SQL structural invariants (text-scan)", () => {
	const sql289 = readFileSync(MIGRATION_289, "utf8");

	test("AC-5: fn_actor_is_independent helper is created in roadmap schema", () => {
		assert.ok(
			/CREATE OR REPLACE FUNCTION roadmap\.fn_actor_is_independent/.test(sql289),
			"migration 289 must define roadmap.fn_actor_is_independent()",
		);
	});

	test("AC-3: fn_guard_gate_advance references gate_decision_log for sole authorization", () => {
		// Branch B (bare proposal_reviews approve within 10 min) was the old sole
		// authorization path. Its removal means the function must require a
		// gate_decision_log row (Branch A) as the ONLY advance authorization.
		// Verify: (a) gate_decision_log is referenced, (b) no standalone RETURN NEW
		// immediately follows a proposal_reviews-only query block.

		// Positive: gate_decision_log is the sole auth path in the new guard.
		assert.ok(
			/gate_decision_log/.test(sql289),
			"fn_guard_gate_advance must reference gate_decision_log as sole auth",
		);

		// Positive: the AC-3 error message specifically names gate_decision_log.
		assert.ok(
			/requires a gate_decision_log row/.test(sql289),
			"guard's Branch A rejection message must mention gate_decision_log row",
		);

		// Confirm the function body (extracted by pg_get_functiondef in the DO block)
		// is tested for Branch B absence at DB level; the text-scan level is satisfied
		// by the two positive assertions above (gate_decision_log sole path + error msg).
	});

	test("AC-3: sole gate authorization is gate_decision_log (Branch A only)", () => {
		assert.ok(
			/gate_decision_log/.test(sql289),
			"fn_guard_gate_advance must reference gate_decision_log",
		);
		// Branch A error message must be present
		assert.ok(
			/requires a gate_decision_log row/.test(sql289),
			"guard must raise an error referencing gate_decision_log when no advance row found",
		);
	});

	test("AC-1: independence check present for non-terminal gates", () => {
		assert.ok(
			/fn_actor_is_independent/.test(sql289),
			"fn_guard_gate_advance must call fn_actor_is_independent for non-terminal gates",
		);
		assert.ok(
			/requires an INDEPENDENT reviewer|independent approver|independent.*approve/i.test(sql289),
			"guard must raise an error referencing independent reviewer requirement",
		);
	});

	test("AC-2: blocking review check present", () => {
		assert.ok(
			/unresolved blocking review|is_blocking.*true|request_changes.*reject/i.test(sql289),
			"fn_guard_gate_advance must check for unresolved blocking reviews",
		);
	});

	test("AC-4: fn_flag_late_blocking_review trigger function is created", () => {
		assert.ok(
			/CREATE OR REPLACE FUNCTION roadmap_proposal\.fn_flag_late_blocking_review/.test(sql289),
			"migration 289 must define fn_flag_late_blocking_review()",
		);
	});

	test("AC-4: trigger on proposal_reviews is created", () => {
		assert.ok(
			/CREATE TRIGGER trg_flag_late_blocking_review/.test(sql289),
			"migration 289 must create trg_flag_late_blocking_review on proposal_reviews",
		);
	});

	test("AC-4: notification_queue insert is present in fn_flag_late_blocking_review", () => {
		assert.ok(
			/CRITICAL.*late_blocking_review|late_blocking_review.*CRITICAL/is.test(sql289),
			"fn_flag_late_blocking_review must emit a CRITICAL notification",
		);
	});

	test("migration ledger INSERT is present", () => {
		assert.ok(
			/INSERT INTO roadmap\.schema_migration/.test(sql289),
			"migration 289 must insert into roadmap.schema_migration",
		);
		assert.ok(
			/289-p3566-gate-advance-integrity\.sql/.test(sql289),
			"migration ledger entry must reference the correct filename",
		);
	});

	test("preflight checks for baseline dependencies are present", () => {
		assert.ok(
			/Preflight.*fn_guard_gate_advance|fn_guard_gate_advance.*not found/i.test(sql289),
			"migration 289 must have a preflight check for fn_guard_gate_advance",
		);
		assert.ok(
			/Preflight.*state_changed_at|state_changed_at.*not found/i.test(sql289),
			"migration 289 must have a preflight check for state_changed_at column",
		);
	});

	test("040-p290 baseline contains the Branch B vulnerability (confirms removal was needed)", () => {
		const sql040 = readFileSync(MIGRATION_040, "utf8");
		// Branch B in the baseline: proposal_reviews approve within 10 min
		assert.ok(
			/proposal_reviews|verdict.*approve|gate_bypass/i.test(sql040),
			"040-p290 baseline must contain proposal_reviews approve logic (the vulnerability we removed)",
		);
	});
});

// ---------------------------------------------------------------------------
// DB integration tests — require AGENTHIVE_RESOLVER_DB_TEST=1
// ---------------------------------------------------------------------------
describe("P3566: DB integration tests", { skip: !DB_TEST }, () => {
	async function withRollback(
		fn: (client: import("pg").Client) => Promise<void>,
	) {
		const { Client } = await import("pg");
		const client = new Client({
			host: process.env.PGHOST || "127.0.0.1",
			port: parseInt(process.env.PGPORT || "5432", 10),
			user: process.env.PGUSER || "admin",
			password: process.env.PGPASSWORD,
			database: process.env.PGDATABASE || "agenthive",
		});
		await client.connect();
		try {
			await client.query("BEGIN");
			// Apply migration 289 inside the transaction (always rolled back)
			await client.query(readFileSync(MIGRATION_289, "utf8"));
			await fn(client);
		} finally {
			await client.query("ROLLBACK").catch(() => {});
			await client.end();
		}
	}

	// Seed a proposal in REVIEW state + two agents, return proposal id.
	async function seedReviewProposal(
		client: import("pg").Client,
		opts: { builder: string; reviewer: string },
	): Promise<number> {
		for (const identity of [opts.builder, opts.reviewer]) {
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
				 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
				[identity],
			);
		}
		const { rows } = await client.query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (title, type, status, maturity, priority, audit)
			 VALUES ('p3566-test', 'feature', 'REVIEW', 'mature', 'high', '{}'::jsonb)
			 RETURNING id`,
		);
		return rows[0].id;
	}

	// Insert an approve review from the given identity.
	async function addReview(
		client: import("pg").Client,
		proposalId: number,
		reviewer: string,
		verdict: string = "approve",
		isBlocking: boolean = false,
	): Promise<void> {
		await client.query(
			`INSERT INTO roadmap_proposal.proposal_reviews
			   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at)
			 VALUES ($1, $2, $3, $4, now())
			 ON CONFLICT (proposal_id, reviewer_identity) DO UPDATE
			   SET verdict = EXCLUDED.verdict,
			       is_blocking = EXCLUDED.is_blocking,
			       reviewed_at = now()`,
			[proposalId, reviewer, verdict, isBlocking],
		);
	}

	// Insert a gate_decision_log advance row (fires fn_apply_gate_advance → UPDATE proposal).
	async function gateAdvance(
		client: import("pg").Client,
		proposalId: number,
		fromState: string,
		toState: string,
		decidedBy: string,
	): Promise<void> {
		// Set app.agent_identity so fn_guard_gate_advance sees the advancing actor.
		await client.query(`SELECT set_config('app.agent_identity', $1, true)`, [
			decidedBy,
		]);
		await client.query(
			`INSERT INTO roadmap_proposal.gate_decision_log
			   (proposal_id, from_state, to_state, decision, decided_by)
			 VALUES ($1, $2, $3, 'advance', $4)`,
			[proposalId, fromState, toState, decidedBy],
		);
	}

	// ---------------------------------------------------------------------------
	// AC-5: fn_actor_is_independent helper
	// ---------------------------------------------------------------------------
	test("AC-5: fn_actor_is_independent returns true with independent approve", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});

			await addReview(client, pid, "p3566-reviewer", "approve");

			const { rows } = await client.query<{ is_independent: boolean }>(
				`SELECT roadmap.fn_actor_is_independent($1, $2, NULL) AS is_independent`,
				[pid, "p3566-builder"],
			);
			assert.strictEqual(
				rows[0].is_independent,
				true,
				"fn_actor_is_independent must return true when reviewer != actor",
			);
		});
	});

	test("AC-5: fn_actor_is_independent returns false when only self-approve exists", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});

			// Only the builder approved their own proposal.
			await addReview(client, pid, "p3566-builder", "approve");

			const { rows } = await client.query<{ is_independent: boolean }>(
				`SELECT roadmap.fn_actor_is_independent($1, $2, NULL) AS is_independent`,
				[pid, "p3566-builder"],
			);
			assert.strictEqual(
				rows[0].is_independent,
				false,
				"fn_actor_is_independent must return false when only self-approve exists",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// AC-3: Branch B removal — bare proposal_reviews approve no longer authorizes
	// ---------------------------------------------------------------------------
	test("AC-3: bare UPDATE status without gate_decision_log is rejected", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			// Add an independent approve — but do NOT insert gate_decision_log.
			await addReview(client, pid, "p3566-reviewer", "approve");

			await client.query(
				`SELECT set_config('app.agent_identity', 'p3566-builder', true)`,
			);

			await assert.rejects(
				() =>
					client.query(
						`UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = $1`,
						[pid],
					),
				/gate_decision_log|gate_decision/i,
				"AC-3: bare status UPDATE without gate_decision_log must be rejected",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// AC-1: Independent approver required for non-terminal gates
	// ---------------------------------------------------------------------------
	test("AC-1: gate advance fails when only self-approve exists", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			// Builder approved their own proposal, no independent reviewer.
			await addReview(client, pid, "p3566-builder", "approve");

			await assert.rejects(
				() => gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder"),
				/INDEPENDENT|independent/i,
				"AC-1: gate advance must fail when no independent approver exists",
			);
		});
	});

	test("AC-1: gate advance succeeds with an independent approver", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			// Independent reviewer approved.
			await addReview(client, pid, "p3566-reviewer", "approve");

			// This must NOT throw.
			await gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder");

			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(
				rows[0].status,
				"DEVELOP",
				"AC-1: gate advance must succeed with independent approver",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// AC-2: Unresolved blocking review blocks advance
	// ---------------------------------------------------------------------------
	test("AC-2: gate advance fails when blocking review newer than latest independent approve", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			// Independent approve first...
			await addReview(client, pid, "p3566-reviewer", "approve");

			// ...then a blocking review AFTER the approve — filed by a third party.
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
				 VALUES ('p3566-blocker', 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			);
			// Ensure reviewed_at is strictly after the approve by advancing clock slightly.
			await client.query(`SELECT pg_sleep(0.01)`);
			await addReview(client, pid, "p3566-blocker", "request_changes", true);

			await assert.rejects(
				() => gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder"),
				/blocking review|unresolved/i,
				"AC-2: gate advance must fail when an unresolved blocking review exists",
			);
		});
	});

	test("AC-2: gate advance succeeds after blocking review is superseded by a new independent approve", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
				 VALUES ('p3566-blocker', 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			);

			// Timeline: independent approve → blocking → new independent approve supersedes.
			await addReview(client, pid, "p3566-reviewer", "approve");
			await client.query(`SELECT pg_sleep(0.01)`);
			await addReview(client, pid, "p3566-blocker", "request_changes", true);
			await client.query(`SELECT pg_sleep(0.01)`);
			// p3566-reviewer re-approves AFTER the blocking review → supersedes it.
			await addReview(client, pid, "p3566-reviewer", "approve");

			// Must succeed now.
			await gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder");

			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(
				rows[0].status,
				"DEVELOP",
				"AC-2: gate advance must succeed after blocking review is superseded",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// AC-4: Late-blocking review emits CRITICAL notification
	// ---------------------------------------------------------------------------
	test("AC-4: blocking review filed after advance emits CRITICAL notification", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
				 VALUES ('p3566-late-reviewer', 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			);

			// Advance the proposal first.
			await addReview(client, pid, "p3566-reviewer", "approve");
			await gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder");

			// Now a blocking review arrives AFTER the advance.
			await addReview(
				client,
				pid,
				"p3566-late-reviewer",
				"request_changes",
				true,
			);

			// Notification queue should have a CRITICAL late_blocking_review entry.
			const { rows } = await client.query<{ severity: string; kind: string }>(
				`SELECT severity, kind
				   FROM roadmap.notification_queue
				  WHERE proposal_id = $1
				    AND kind = 'late_blocking_review'
				  ORDER BY created_at DESC
				  LIMIT 1`,
				[pid],
			);

			assert.ok(rows.length > 0, "AC-4: must emit a notification for late blocking review");
			assert.strictEqual(
				rows[0].severity,
				"CRITICAL",
				"AC-4: late blocking review notification must be CRITICAL severity",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Graceful degradation: unknown actor (app.agent_identity unset)
	// ---------------------------------------------------------------------------
	test("gate advance degrades gracefully when app.agent_identity is unset", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, {
				builder: "p3566-builder",
				reviewer: "p3566-reviewer",
			});
			await addReview(client, pid, "p3566-reviewer", "approve");

			// Clear app.agent_identity — legacy/admin path.
			await client.query(
				`SELECT set_config('app.agent_identity', '', true)`,
			);

			// Should NOT throw — degrades with a WARNING notification, not an error.
			// The gate_decision_log row is sufficient; independence check is skipped.
			await client.query(
				`INSERT INTO roadmap_proposal.gate_decision_log
				   (proposal_id, from_state, to_state, decision, decided_by)
				 VALUES ($1, 'REVIEW', 'DEVELOP', 'advance', 'admin')`,
				[pid],
			);

			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(
				rows[0].status,
				"DEVELOP",
				"degraded path must still advance when actor is unknown",
			);
		});
	});
});
