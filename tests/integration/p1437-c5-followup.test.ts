/**
 * V3-C5 (P1437) follow-up (codex review #8685):
 *  - prove boot wires validateChannelRegistry()
 *  - regression: the stale-session guard preserves a HEALTHY active session
 *    (the risk-bearing fix — must never close a live concurrent liaison's row).
 */

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const HEALTHY = "v3c5-healthy-agency";
const STALE = "v3c5-stale-agency";

// The exact heal-guard statement from liaison-service.ts:liaisonRegister.
const HEAL_SQL = `
	UPDATE roadmap.agency_liaison_session s
	   SET ended_at = now(), end_reason = COALESCE(end_reason, 'orphan-heal-on-register')
	 WHERE s.agency_id = $1
	   AND s.ended_at IS NULL
	   AND NOT EXISTS (
	     SELECT 1 FROM roadmap.agency a
	      WHERE a.agency_id = $1
	        AND a.last_heartbeat_at IS NOT NULL
	        AND a.last_heartbeat_at > now() - interval '90 seconds'
	   )`;

test("P1437 AC-3: orchestrator boot wires validateChannelRegistry()", () => {
	const src = readFileSync(
		new URL("../../src/core/orchestration/orchestrator.ts", import.meta.url),
		"utf8",
	);
	assert.match(
		src,
		/import\s*\{\s*validateChannelRegistry\s*\}/,
		"orchestrator must import the channel validator",
	);
	// Called inside start() (after the async start signature).
	const startIdx = src.indexOf("async start(");
	assert.ok(startIdx > 0, "start() must exist");
	assert.ok(
		src.indexOf("validateChannelRegistry()", startIdx) > startIdx,
		"start() must call validateChannelRegistry() at boot",
	);
});

test("P1437 AC-2 regression: stale-guard heals a dead orphan but PRESERVES a healthy session", async () => {
	const c = new Client({ connectionString: DB_URL });
	await c.connect();
	try {
		await c.query("BEGIN");

		// Two scratch agencies: one heartbeating now (healthy), one stale.
		for (const [id, hb] of [
			[HEALTHY, "now()"],
			[STALE, "now() - interval '10 minutes'"],
		] as const) {
			await c.query(
				`INSERT INTO roadmap.agency
				   (agency_id, display_name, provider, host_id, capability_tags, status, presence_state, last_heartbeat_at)
				 VALUES ($1,$1,'claude','bot',ARRAY[]::text[],'active','online', ${hb})
				 ON CONFLICT (agency_id) DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at`,
				[id],
			);
			await c.query(
				`INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
				 VALUES ($1, 'bot', now() - interval '1 hour')`,
				[id],
			);
		}

		// Healthy agency: heal must NOT close the live session (split-brain guard).
		const healed = await c.query(HEAL_SQL, [HEALTHY]);
		assert.equal(healed.rowCount, 0, "healthy active session must be preserved");
		const healthyActive = await c.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM roadmap.agency_liaison_session
			  WHERE agency_id = $1 AND ended_at IS NULL`,
			[HEALTHY],
		);
		assert.equal(Number(healthyActive.rows[0].n), 1, "healthy session still active");

		// Stale agency: heal closes the dead orphan.
		const reaped = await c.query(HEAL_SQL, [STALE]);
		assert.equal(reaped.rowCount, 1, "stale orphan session must be healed");
		const staleActive = await c.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM roadmap.agency_liaison_session
			  WHERE agency_id = $1 AND ended_at IS NULL`,
			[STALE],
		);
		assert.equal(Number(staleActive.rows[0].n), 0, "stale session closed");
	} finally {
		await c.query("ROLLBACK").catch(() => {});
		await c.end();
	}
});
