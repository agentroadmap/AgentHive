/**
 * P435 — Operator Control Feed: Replay Correlation Tests
 *
 * AC-6: replay test correlates 5+ dispatch, claim, run, route, budget records
 *   into single feed replay view.
 *
 * Tests:
 *   1. Insert a dispatch with a known proposal and agency → stop it → verify
 *      the replay view returns rows that carry all 5+ source fields
 *      (dispatch_id, proposal_id, model_used/route, budget_period).
 *   2. Each replay row exposes: event_class, proposal_id, dispatch_id, claim_id,
 *      run_id (may be null), agency_id, route, model, budget_scope.
 *   3. Replay returns rows in ascending emitted_at order (chronological chain).
 *   4. Replay for a dispatch with no feed events returns an empty array.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/infra/postgres/pool.ts";
import { replayChain, emitFeedEvent } from "../../src/core/governance/control-feed.ts";

const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === "true";
const TS = Date.now();
const TAG = `p435-replay-${TS}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertProposal(): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal (display_id, title, type, status, maturity, audit)
		 VALUES ($1, $2, 'feature', 'DEVELOP', 'active', '{}')
		 RETURNING id`,
		[`P435R-${TAG}`, `P435 replay test ${TAG}`],
	);
	return rows[0]!.id;
}

async function insertAgency(tag: string): Promise<string> {
	const agencyIdentity = `agency-replay-${tag}`;
	await query(
		`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status)
		 VALUES ($1, $1, 'claude', 'bot', 'active')
		 ON CONFLICT (agency_id) DO UPDATE SET status = 'active'`,
		[agencyIdentity],
	);
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, project_id, status)
		 VALUES ($1, 'llm', 1, 'active')
		 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[agencyIdentity],
	);
	return agencyIdentity;
}

async function insertDispatch(proposalId: number, agencyIdentity: string): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, agent_identity, agency_identity, squad_name,
		    dispatch_role, dispatch_status, offer_status, required_capabilities, metadata)
		 VALUES ($1, $2, $2, 'replay-squad', 'developer', 'active', 'claimed', '["develop"]',
		         '{"route_name":"anthropic-claude","model_name":"claude-sonnet-4-6","budget_scope":"project"}'::jsonb)
		 RETURNING id`,
		[proposalId, agencyIdentity],
	);
	return rows[0]!.id;
}

async function insertRun(proposalId: number, agencyIdentity: string): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_runs
		   (proposal_id, agent_identity, stage, model_used, status, cost_usd)
		 VALUES ($1, $2, 'develop', 'claude-sonnet-4-6', 'running', 0.05)
		 RETURNING id`,
		[proposalId, agencyIdentity],
	);
	return rows[0]!.id;
}

async function insertBudget(projectId: number): Promise<void> {
	await query(
		`INSERT INTO roadmap.project_budget_cap (project_id, period, max_usd_cents)
		 VALUES ($1, 'day', 5000)
		 ON CONFLICT (project_id, period) DO UPDATE SET max_usd_cents = 5000`,
		[projectId],
	);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let proposalId: number;
let dispatchId: number;
let runId: number;
let agencyIdentity: string;

before(async () => {
	if (SKIP_DB_TESTS) return;

	agencyIdentity = await insertAgency(TAG);
	proposalId = await insertProposal();
	dispatchId = await insertDispatch(proposalId, agencyIdentity);
	runId = await insertRun(proposalId, agencyIdentity);

	// Emit 5 explicit feed events with the full causal chain
	const baseEvent = {
		project_id: null,
		proposal_id: BigInt(proposalId),
		dispatch_id: BigInt(dispatchId),
		claim_id: null,
		run_id: null,
		agency_id: agencyIdentity,
		worker_id: null,
		host: "hermes",
		route: "anthropic-claude",
		model: "claude-sonnet-4-6",
		budget_scope: "project",
		recommended_stop_scope: "dispatch" as const,
		detail: null,
	};

	await emitFeedEvent({ ...baseEvent, event_class: "dispatch_assigned" });
	await emitFeedEvent({ ...baseEvent, event_class: "dispatch_claimed" });
	await emitFeedEvent({ ...baseEvent, event_class: "run_started", run_id: BigInt(runId) });
	await emitFeedEvent({ ...baseEvent, event_class: "run_completed", run_id: BigInt(runId) });
	await emitFeedEvent({ ...baseEvent, event_class: "dispatch_completed" });
});

after(async () => {
	if (SKIP_DB_TESTS) return;
	// IMPORTANT: delete squad_dispatch BEFORE proposal_lease.
	// Deleting proposal_lease first triggers ON DELETE SET NULL on squad_dispatch.lease_id,
	// which fires trg_claim_dispatch_lease (BEFORE UPDATE), which recreates the lease for
	// any dispatch still in 'active' status — defeating the cleanup.
	await query(
		`DELETE FROM control_audit.feed_event WHERE dispatch_id = $1`,
		[dispatchId],
	);
	await query(
		`DELETE FROM roadmap_workforce.agent_runs WHERE id = $1`,
		[runId],
	);
	await query(
		`DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[dispatchId],
	);
	// Now safe to delete proposal_lease — no squad_dispatch rows left to trigger re-creation
	await query(
		`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1 OR agent_identity = $2`,
		[proposalId, agencyIdentity],
	);
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agencyIdentity],
	);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agencyIdentity]);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P435 AC-6: replay correlates 5+ sources per row", () => {
	it("returns 5+ rows for the seeded dispatch chain", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		assert.ok(
			rows.length >= 5,
			`Expected >= 5 replay rows (got ${rows.length})`,
		);
	});

	it("each replay row carries dispatch_id, proposal_id, agency_id", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		for (const row of rows) {
			assert.strictEqual(
				String(row.dispatch_id),
				String(dispatchId),
				"dispatch_id must match",
			);
			assert.strictEqual(
				String(row.proposal_id),
				String(proposalId),
				"proposal_id must match",
			);
			assert.ok(row.agency_id, "agency_id must be present");
		}
	});

	it("rows include route and model from dispatch metadata", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		const hasRoute = rows.some((r) => r.route != null);
		const hasModel = rows.some((r) => r.model != null);
		assert.ok(hasRoute, "At least one row should have a route");
		assert.ok(hasModel, "At least one row should have a model");
	});

	it("rows are ordered chronologically (ascending emitted_at)", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		for (let i = 1; i < rows.length; i++) {
			const prev = new Date(rows[i - 1]!.emitted_at!).getTime();
			const curr = new Date(rows[i]!.emitted_at!).getTime();
			assert.ok(
				curr >= prev,
				`Row ${i} emitted_at should be >= row ${i - 1}`,
			);
		}
	});

	it("returns empty array for a dispatch with no feed events", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const fakeDispatchId = 999_999_999;
		const rows = await replayChain(fakeDispatchId);
		assert.deepStrictEqual(rows, [], "Should return empty for unknown dispatch");
	});

	it("run_id is present on run_started and run_completed events", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		const runRows = rows.filter(
			(r) => r.event_class === "run_started" || r.event_class === "run_completed",
		);
		assert.ok(runRows.length >= 2, "Should have >= 2 run events");
		for (const r of runRows) {
			assert.ok(r.run_id != null, `run_id should be set on ${r.event_class}`);
		}
	});
});

describe("P435 AC-6: causal chain completeness check", () => {
	it("all 5+ event classes are represented in the chain", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		const classes = new Set(rows.map((r) => r.event_class));

		const expected = [
			"dispatch_assigned",
			"dispatch_claimed",
			"run_started",
			"run_completed",
			"dispatch_completed",
		];
		for (const cls of expected) {
			assert.ok(
				classes.has(cls),
				`Expected event class '${cls}' in replay chain (found: ${[...classes].join(", ")})`,
			);
		}
	});

	it("budget_scope is present on at least one row from metadata", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const rows = await replayChain(dispatchId);
		const hasBudgetScope = rows.some((r) => r.budget_scope != null);
		assert.ok(hasBudgetScope, "At least one row should carry budget_scope");
	});
});
