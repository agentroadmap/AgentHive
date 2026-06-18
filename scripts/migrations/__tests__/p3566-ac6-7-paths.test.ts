import assert from "node:assert";
import { describe, test } from "node:test";

/**
 * P3566 AC-6 + AC-7 — DB integration tests against the LIVE guard
 * (roadmap_proposal.fn_guard_gate_advance, already applied via mig 289/291),
 * exercised inside ROLLBACK transactions so nothing is persisted.
 *
 *   AC-6: single-agency degradation — independence floor is distinct ACTOR
 *         identity (never deadlocks): a distinct-session approve advances; a
 *         same-identity self-approve is refused.
 *   AC-7: hard invariant across ALL advance paths — the guard is a trigger on
 *         the proposal status change, so a direct/force status UPDATE and the
 *         gate_decision path are BOTH subject to AC-1..3 (force overrides the
 *         lease, never the authorization).
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3566-ac6-7-paths.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

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
		await fn(client);
	} finally {
		await client.query("ROLLBACK").catch(() => {});
		await client.end();
	}
}

async function seedReviewProposal(
	client: import("pg").Client,
	identities: string[],
): Promise<number> {
	for (const identity of identities) {
		await client.query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
			 VALUES ($1, 'llm') ON CONFLICT (agent_identity) DO NOTHING`,
			[identity],
		);
	}
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (title, type, status, maturity, priority, audit)
		 VALUES ('p3566-ac67-test', 'feature', 'REVIEW', 'mature', 'high', '{}'::jsonb)
		 RETURNING id`,
	);
	return rows[0].id;
}

async function addReview(
	client: import("pg").Client,
	proposalId: number,
	reviewer: string,
	verdict = "approve",
	isBlocking = false,
): Promise<void> {
	await client.query(
		`INSERT INTO roadmap_proposal.proposal_reviews
		   (proposal_id, reviewer_identity, verdict, is_blocking, reviewed_at)
		 VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (proposal_id, reviewer_identity) DO UPDATE
		   SET verdict = EXCLUDED.verdict, is_blocking = EXCLUDED.is_blocking, reviewed_at = now()`,
		[proposalId, reviewer, verdict, isBlocking],
	);
}

// Insert a gate_decision_log advance row (fires fn_apply_gate_advance → UPDATE
// proposal → fn_guard_gate_advance). Throws if the guard refuses.
async function gateAdvance(
	client: import("pg").Client,
	proposalId: number,
	fromState: string,
	toState: string,
	decidedBy: string,
): Promise<void> {
	await client.query(`SELECT set_config('app.agent_identity', $1, true)`, [decidedBy]);
	await client.query(
		`INSERT INTO roadmap_proposal.gate_decision_log
		   (proposal_id, from_state, to_state, decision, decided_by)
		 VALUES ($1, $2, $3, 'advance', $4)`,
		[proposalId, fromState, toState, decidedBy],
	);
}

describe("P3566 AC-6 + AC-7: live-guard path coverage (DB)", { skip: !DB_TEST }, () => {
	// ---- AC-6: single-agency degradation ----
	test("AC-6: a distinct-session independent approve advances (single-agency floor, no deadlock)", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, ["p3566-solo", "p3566-solo-s2"]);
			await addReview(client, pid, "p3566-solo-s2", "approve"); // distinct session
			await assert.doesNotReject(
				() => gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-solo"),
				"a distinct-session approve satisfies the independence floor",
			);
			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(rows[0].status, "DEVELOP");
		});
	});

	test("AC-6: same-identity self-approve is refused (the floor, not a deadlock)", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, ["p3566-solo"]);
			await addReview(client, pid, "p3566-solo", "approve"); // self
			// Via the gate_decision path, fn_apply_gate_advance catches the guard's
			// RAISE, records a gate-auth-violation note, and leaves status=REVIEW
			// (silent block — no exception).
			await gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-solo");
			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(rows[0].status, "REVIEW", "self-approve must not advance the proposal");
			const { rows: notes } = await client.query<{ body: string }>(
				`SELECT body FROM roadmap_proposal.proposal_discussions
				  WHERE proposal_id = $1 AND context_prefix = 'gate-auth-violation:'
				  ORDER BY created_at DESC LIMIT 1`,
				[pid],
			);
			assert.ok(notes.length > 0, "a gate-auth-violation note must be written");
			assert.ok(/independent|AC-1/i.test(notes[0].body));
		});
	});

	// ---- AC-7: hard invariant across all paths (incl force) ----
	test("AC-7: a direct/force-style status UPDATE cannot bypass the guard", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, ["p3566-builder", "p3566-reviewer"]);
			await addReview(client, pid, "p3566-builder", "approve"); // self only, no gate_decision_log
			await client.query(`SELECT set_config('app.agent_identity', 'p3566-builder', true)`);
			await assert.rejects(
				() =>
					client.query(
						`UPDATE roadmap_proposal.proposal SET status = 'DEVELOP' WHERE id = $1`,
						[pid],
					),
				/gate_decision_log|INDEPENDENT/i,
				"a bare/force status UPDATE must still route through fn_guard_gate_advance",
			);
		});
	});

	test("AC-7: the gate_decision path enforces independence (force cannot self-approve through)", async () => {
		await withRollback(async (client) => {
			const pid = await seedReviewProposal(client, ["p3566-builder", "p3566-reviewer"]);
			await addReview(client, pid, "p3566-builder", "approve"); // self only
			// gate_decision path: silent-block (note + status unchanged), per the
			// fn_apply_gate_advance contract.
			await gateAdvance(client, pid, "REVIEW", "DEVELOP", "p3566-builder");
			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			assert.strictEqual(
				rows[0].status,
				"REVIEW",
				"a self-approved-only advance must not change status on the gate_decision path either",
			);
		});
	});
});
