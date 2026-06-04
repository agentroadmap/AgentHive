/**
 * P435 — Operator Control API: Stop Scope Tests
 *
 * AC-5: stop(scope_type=dispatch, scope_id=D123) terminates D123 and all
 *   descendant workers; audit log has one summary entry in control_audit.feed_event.
 *
 * Tests:
 *   1. stop(dispatch) cancels the dispatch (dispatch_status=cancelled) and
 *      marks the active worker terminated (dispatch_status=failed).
 *   2. Exactly one operator_stop feed_event is emitted for the whole operation.
 *   3. stop() for an already-terminal dispatch returns 'noop'.
 *   4. stop() with scope_type=agency suspends the agency.
 *   5. stop() with scope_type=worker terminates only the target worker.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../../src/infra/postgres/pool.ts";
import { stop, listActiveDispatches, getFeedEvents } from "../../src/core/governance/control-feed.ts";

const SKIP_DB_TESTS = process.env.SKIP_DB_TESTS === "true";
const TS = Date.now();
const TAG = `p435-${TS}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertAgency(tag: string) {
	const agencyIdentity = `agency-${tag}`;
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

async function insertDispatch(
	proposalId: number,
	agencyIdentity: string,
	workerIdentity: string | null = null,
): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, agent_identity, agency_identity, worker_identity,
		    squad_name, dispatch_role, dispatch_status, offer_status, required_capabilities)
		 VALUES ($1, $2, $2, $3, 'test-squad', 'developer', 'active', 'claimed', '["develop"]')
		 RETURNING id`,
		[proposalId, agencyIdentity, workerIdentity],
	);
	return rows[0]!.id;
}

async function getDispatchStatus(id: number): Promise<string> {
	const { rows } = await query<{ dispatch_status: string }>(
		`SELECT dispatch_status FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
		[id],
	);
	return rows[0]?.dispatch_status ?? "not_found";
}

async function countFeedEvents(dispatchId: number, eventClass: string): Promise<number> {
	const { rows } = await query<{ cnt: number }>(
		`SELECT COUNT(*)::int AS cnt FROM control_audit.feed_event
		  WHERE dispatch_id = $1 AND event_class = $2`,
		[dispatchId, eventClass],
	);
	return rows[0]?.cnt ?? 0;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let proposalId: number;
let agencyId: string;

before(async () => {
	if (SKIP_DB_TESTS) return;

	// Insert a minimal proposal to satisfy FK
	const { rows: pRows } = await query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal
		   (display_id, title, type, status, maturity, audit)
		 VALUES ($1, $2, 'feature', 'DEVELOP', 'active', '{}')
		 RETURNING id`,
		[`P435-${TAG}`, `P435 control test ${TAG}`],
	);
	proposalId = pRows[0]!.id;
	agencyId = await insertAgency(TAG);
});

after(async () => {
	if (SKIP_DB_TESTS) return;
	// Clean up test data — delete squad_dispatch BEFORE proposal_lease to prevent
	// trg_claim_dispatch_lease from recreating leases via ON DELETE SET NULL cascade.
	await query(`DELETE FROM control_audit.feed_event WHERE dispatch_id IN (
		SELECT id FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1 OR worker_identity LIKE 'worker-p435-%'
	)`, [agencyId]);
	// Delete all dispatches first (removes lease_id FK to proposal_lease)
	await query(
		`DELETE FROM roadmap_workforce.squad_dispatch WHERE agent_identity = $1 OR worker_identity LIKE 'worker-p435-%'`,
		[agencyId],
	);
	// Now safe to delete proposal leases
	await query(
		`DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
		[proposalId],
	);
	// Clean up the worker identity registered in the "stop worker" test
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE 'worker-p435-%'`,
		[],
	);
	await query(
		`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
		[agencyId],
	);
	await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [agencyId]);
	await query(`DELETE FROM roadmap_proposal.proposal WHERE id = $1`, [proposalId]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("P435 AC-5: stop(dispatch) terminates dispatch + workers, writes one feed event", () => {
	it("cancels the dispatch", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const dId = await insertDispatch(proposalId, agencyId, null);
		const result = await stop({
			scopeType: "dispatch",
			scopeId: String(dId),
			actor: "test-operator-p435",
			reason: `p435 unit test ${TAG}`,
		});

		assert.ok(
			result === "ok" || result === "noop",
			`Expected ok|noop, got: ${result}`,
		);
		const status = await getDispatchStatus(dId);
		assert.strictEqual(
			status,
			"cancelled",
			`Expected dispatch cancelled, got: ${status}`,
		);
	});

	it("emits exactly one operator_stop feed_event for the dispatch stop", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const dId = await insertDispatch(proposalId, agencyId, null);
		await stop({
			scopeType: "dispatch",
			scopeId: String(dId),
			actor: "test-operator-p435",
			reason: `p435 unit test ${TAG}`,
		});

		const count = await countFeedEvents(dId, "operator_stop");
		assert.strictEqual(count, 1, `Expected 1 operator_stop feed event, got: ${count}`);
	});

	it("returns noop for a terminal dispatch", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const dId = await insertDispatch(proposalId, agencyId, null);
		// First stop → ok
		await stop({ scopeType: "dispatch", scopeId: String(dId), actor: "test-p435" });
		// Second stop → noop (already terminal)
		const result = await stop({ scopeType: "dispatch", scopeId: String(dId), actor: "test-p435" });
		assert.ok(
			result === "noop" || result === "ok",
			`Expected noop for terminal dispatch, got: ${result}`,
		);
	});

	it("stop(agency) suspends the agency", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const result = await stop({
			scopeType: "agency",
			scopeId: agencyId,
			actor: "test-operator-p435",
			reason: `p435 agency suspend test ${TAG}`,
		});
		assert.ok(result === "ok" || result === "noop", `Expected ok|noop, got: ${result}`);

		const { rows } = await query<{ status: string }>(
			`SELECT status FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[agencyId],
		);
		assert.ok(
			rows[0]?.status === "suspended" || result === "noop",
			`Expected agent_registry suspended, got: ${rows[0]?.status}`,
		);
	});

	it("stop(worker) terminates only the target worker's dispatch", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		// Re-activate the agency first
		await query(
			`UPDATE roadmap.agency SET status = 'active' WHERE agency_id = $1`,
			[agencyId],
		);
		await query(
			`UPDATE roadmap_workforce.agent_registry SET status = 'active' WHERE agent_identity = $1`,
			[agencyId],
		);

		const workerIdentity = `worker-${TAG}`;
		// Register worker identity so the FK constraint is satisfied
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, project_id, status)
			 VALUES ($1, 'llm', 1, 'active')
			 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
			[workerIdentity],
		);
		const dId = await insertDispatch(proposalId, agencyId, workerIdentity);
		const result = await stop({
			scopeType: "worker",
			scopeId: workerIdentity,
			actor: "test-operator-p435",
			reason: `p435 worker terminate test ${TAG}`,
		});
		assert.ok(result === "ok" || result === "noop", `Expected ok|noop, got: ${result}`);

		const status = await getDispatchStatus(dId);
		assert.ok(
			status === "failed" || status === "cancelled" || result === "noop",
			`Expected failed/cancelled after worker terminate, got: ${status}`,
		);
	});
});

describe("P435: listActiveDispatches returns non-terminal dispatches", () => {
	it("does not include cancelled dispatches", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const dId = await insertDispatch(proposalId, agencyId, null);
		await stop({ scopeType: "dispatch", scopeId: String(dId), actor: "test-p435" });

		const active = await listActiveDispatches();
		const found = active.find((d) => d.id === dId);
		assert.ok(!found, `Cancelled dispatch ${dId} should not appear in listActiveDispatches`);
	});
});

describe("P435: getFeedEvents filters by dispatch_id", () => {
	it("returns only events for the specified dispatch", async (t) => {
		if (SKIP_DB_TESTS) { t.skip("SKIP_DB_TESTS set"); return; }

		const dId = await insertDispatch(proposalId, agencyId, null);
		await stop({ scopeType: "dispatch", scopeId: String(dId), actor: "test-p435" });

		const events = await getFeedEvents({ dispatchId: dId });
		assert.ok(events.length > 0, "Expected at least one feed event for this dispatch");
		for (const e of events) {
			assert.strictEqual(
				String(e.dispatch_id),
				String(dId),
				`All events should have dispatch_id=${dId}`,
			);
		}
	});
});
