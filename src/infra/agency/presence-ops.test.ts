/**
 * P1109 Tier-2 tests for the presence + listener-subscription wrappers.
 *
 * Pure validation tests run anywhere. Live-DB tests are gated behind
 * AGENTHIVE_ALLOW_LIVE_DB=1 (they touch roadmap.agency, roadmap.listener_subscription,
 * roadmap_workforce.agent_registry on the local DB).
 *
 * Run: node --import jiti/register --test src/infra/agency/presence-ops.test.ts
 * Live: AGENTHIVE_ALLOW_LIVE_DB=1 PGPASSWORD=... node --import jiti/register --test ...
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	agentPulse,
	recordListenerSubscription,
	removeListenerSubscription,
	ensureAgentRegistryRow,
} from "./presence-ops.js";
import { query } from "../postgres/pool.js";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

// ── Pure validation (no DB) ──────────────────────────────────────────────────

test("agentPulse rejects empty agency_id", async () => {
	const r = await agentPulse("", "online");
	assert.equal(r.success, false);
	assert.match(r.error ?? "", /agency_id is required/);
});

test("agentPulse rejects invalid state (the fabrication this prevents)", async () => {
	// 'active' is an agency *lifecycle* status, NOT a valid presence state.
	const r = await agentPulse("some-agency", "active" as any);
	assert.equal(r.success, false);
	assert.match(r.error ?? "", /online\|busy\|away\|offline/);
});

test("recordListenerSubscription rejects missing channel", async () => {
	const fakeClient = { query: async () => ({ rows: [] }) };
	const r = await recordListenerSubscription(fakeClient, "ident", "");
	assert.equal(r.success, false);
	assert.match(r.error ?? "", /required/);
});

test("ensureAgentRegistryRow rejects empty identity", async () => {
	const r = await ensureAgentRegistryRow("");
	assert.equal(r.success, false);
});

// ── Live DB ──────────────────────────────────────────────────────────────────

const TEST_AGENCY = "p1109-test-agency";
const TEST_CHANNEL = "msg_p1109-test-agency";

test(
	"AC-3: agentPulse updates roadmap.agency.last_heartbeat_at + presence_state",
	{ skip: !LIVE },
	async () => {
		// Seed agency row (FK anchor first)
		await ensureAgentRegistryRow(TEST_AGENCY);
		await query(
			`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, status, presence_state)
			 VALUES ($1, 'P1109 Test', 'test', 'bot', 'active', 'offline')
			 ON CONFLICT (agency_id) DO UPDATE SET presence_state = 'offline', last_heartbeat_at = NULL`,
			[TEST_AGENCY],
		);

		const before = await query(
			`SELECT last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
			[TEST_AGENCY],
		);
		assert.equal(before.rows[0].last_heartbeat_at, null);

		const r = await agentPulse(TEST_AGENCY, "online");
		assert.equal(r.success, true, r.error);
		assert.equal(r.presence_state, "online");
		assert.ok(r.last_heartbeat_at, "last_heartbeat_at should be populated");

		// Confirm the write landed in the table, not just the return value
		const after = await query(
			`SELECT presence_state, last_heartbeat_at FROM roadmap.agency WHERE agency_id = $1`,
			[TEST_AGENCY],
		);
		assert.equal(after.rows[0].presence_state, "online");
		assert.notEqual(after.rows[0].last_heartbeat_at, null);

		// cleanup
		await query(`DELETE FROM roadmap.agency WHERE agency_id = $1`, [TEST_AGENCY]);
	},
);

test(
	"AC-4 / AC-5: subscribe records a listener row, unsubscribe removes it, reconcile clean",
	{ skip: !LIVE },
	async () => {
		// Use the pooled wrapper as the "client". (pg_backend_pid() will be the
		// pooled backend; for this functional test we only assert the row lifecycle.)
		const client = {
			query: (t: string, v?: unknown[]) => query(t, (v ?? []) as unknown[]),
		};

		// clean slate
		await query(
			`DELETE FROM roadmap.listener_subscription WHERE agent_identity = $1`,
			[TEST_AGENCY],
		);

		const rec = await recordListenerSubscription(client, TEST_AGENCY, TEST_CHANNEL);
		assert.equal(rec.success, true, rec.error);
		assert.ok(typeof rec.established_pid === "number");

		const present = await query(
			`SELECT agent_identity, channel, established_pid, established_at
			   FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[TEST_AGENCY, TEST_CHANNEL],
		);
		assert.equal(present.rows.length, 1, "row should exist after subscribe");
		assert.equal(present.rows[0].channel, TEST_CHANNEL);

		// Idempotent refresh: a second record must not duplicate (PK on
		// (agent_identity, channel)).
		const rec2 = await recordListenerSubscription(client, TEST_AGENCY, TEST_CHANNEL);
		assert.equal(rec2.success, true);
		const count = await query(
			`SELECT count(*)::int AS n FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[TEST_AGENCY, TEST_CHANNEL],
		);
		assert.equal(count.rows[0].n, 1, "refresh must not duplicate the row");

		const rem = await removeListenerSubscription(client, TEST_AGENCY, TEST_CHANNEL);
		assert.equal(rem.success, true, rem.error);

		const gone = await query(
			`SELECT 1 FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[TEST_AGENCY, TEST_CHANNEL],
		);
		assert.equal(gone.rows.length, 0, "row should be removed after unsubscribe");
	},
);

test(
	"AC-14: ensureAgentRegistryRow upserts the FK-anchor row idempotently",
	{ skip: !LIVE },
	async () => {
		await query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[TEST_AGENCY],
		).catch(() => {});

		const r1 = await ensureAgentRegistryRow(TEST_AGENCY);
		assert.equal(r1.success, true, r1.error);
		const r2 = await ensureAgentRegistryRow(TEST_AGENCY);
		assert.equal(r2.success, true, r2.error);

		const rows = await query(
			`SELECT agent_type, status FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[TEST_AGENCY],
		);
		assert.equal(rows.rows.length, 1, "exactly one row");
		assert.equal(rows.rows[0].status, "active");

		await query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[TEST_AGENCY],
		).catch(() => {});
	},
);
