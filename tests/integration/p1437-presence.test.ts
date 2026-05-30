/**
 * V3-C5 (P1437): orphan-session self-heal + channel-contract registry.
 *
 * AC-2: liaisonRegister self-heals an orphan active session (ended_at IS NULL
 * left by a hard-crashed prior liaison) before inserting a new one, so the
 * idx_agency_session_one_active unique index no longer loops the unit on
 * restart (codex-agency-bot looped 553x on 2026-05-29). Tested against the real
 * liaisonRegister inside a rolled-back transaction (zero live impact).
 *
 * AC-3: the channel-contract registry validator rejects the P1408 collision
 * class (one channel pattern, incompatible payload id-types). Pure unit — no DB.
 */

import { test } from "node:test";
import assert from "node:assert";
import { Client } from "pg";
import { liaisonRegister } from "../../src/infra/agency/liaison-service.ts";
import {
	validateChannelRegistry,
	ChannelContractError,
	type ChannelContract,
} from "../../src/infra/messaging/channel-registry.ts";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const SCRATCH_AGENCY = "v3c5-orphan-agency";

test("P1437 AC-2: liaisonRegister self-heals an orphan active session (no unique-violation loop)", async () => {
	const c = new Client({ connectionString: DB_URL });
	await c.connect();
	try {
		await c.query("BEGIN");

		// Scratch agency must exist in roadmap.agency for liaisonRegister to proceed.
		await c.query(
			`INSERT INTO roadmap.agency
			   (agency_id, display_name, provider, host_id, capability_tags, status, presence_state)
			 VALUES ($1, $1, 'claude', 'bot', ARRAY[]::text[], 'active', 'offline')
			 ON CONFLICT (agency_id) DO NOTHING`,
			[SCRATCH_AGENCY],
		);

		// Orphan active session left by a "hard-crashed" prior liaison.
		await c.query(
			`INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
			 VALUES ($1, 'bot', now() - interval '1 hour')`,
			[SCRATCH_AGENCY],
		);

		// Before heal: exactly one active (orphan) session.
		const before = await c.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM roadmap.agency_liaison_session
			  WHERE agency_id = $1 AND ended_at IS NULL`,
			[SCRATCH_AGENCY],
		);
		assert.equal(Number(before.rows[0].n), 1, "precondition: one orphan active session");

		// Real liaisonRegister bound to this txn — must NOT throw a unique violation.
		const res = await liaisonRegister(
			{ agency_id: SCRATCH_AGENCY, display_name: SCRATCH_AGENCY, provider: "claude", host_id: "bot" },
			// liaisonRegister accepts a PoolClient; a pg Client satisfies the same query shape.
			c as never,
		);
		assert.ok(res.session_id, "liaisonRegister returned a new session_id");

		// After heal: still exactly one active session (the new one); orphan closed.
		const after = await c.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM roadmap.agency_liaison_session
			  WHERE agency_id = $1 AND ended_at IS NULL`,
			[SCRATCH_AGENCY],
		);
		assert.equal(Number(after.rows[0].n), 1, "exactly one active session after self-heal");

		// The orphan is now closed with the heal reason.
		const healed = await c.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM roadmap.agency_liaison_session
			  WHERE agency_id = $1 AND end_reason = 'orphan-heal-on-register'`,
			[SCRATCH_AGENCY],
		);
		assert.equal(Number(healed.rows[0].n), 1, "orphan session closed with heal reason");
	} finally {
		await c.query("ROLLBACK").catch(() => {});
		await c.end();
	}
});

test("P1437 AC-3: channel registry validator accepts the canonical set and rejects a collision", () => {
	// The real registry must be self-consistent.
	assert.doesNotThrow(
		() => validateChannelRegistry(),
		"canonical CHANNEL_REGISTRY must validate",
	);

	// The P1408 collision class: one pattern, two incompatible payload id-types.
	const colliding: ChannelContract[] = [
		{
			pattern: "msg_<id>",
			producer: "fn_a2a_message_notify",
			payloadIdType: "bigint",
			payloadSchema: "{ message_id: bigint }",
			listener: "liaison-agent",
		},
		{
			pattern: "msg_<id>",
			producer: "fn_liaison_notify_new_message",
			payloadIdType: "uuid",
			payloadSchema: "{ message_id: uuid }",
			listener: "liaison-hub",
		},
	];
	assert.throws(
		() => validateChannelRegistry(colliding),
		ChannelContractError,
		"validator must reject a bigint-vs-uuid collision on one channel pattern",
	);
});
