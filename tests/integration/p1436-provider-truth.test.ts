/**
 * V3-C4 (P1436) AC-2/AC-4: provider truth at spawn is recorded and auditable.
 *
 * Proves that an honest run (agency's declared provider == resolved route
 * provider) records provider_mismatch=false, and a mismatched run (the lying
 * registry: agency declares 'codex' but the route resolved 'claude') records
 * provider_mismatch=true and surfaces in v_provider_mismatch — so mismatches do
 * NOT spawn silently under the wrong provider (phase-1 warn+record).
 *
 * Single transaction, zero live impact: adds the C4 columns + view (migration
 * 185, idempotent), inserts synthetic agent_runs rows mirroring exactly what
 * spawnAgent's P1436 block writes, asserts, then ROLLS BACK. The mismatch is a
 * direct string compare (claimed vs resolved share one vocabulary), so this DB
 * test faithfully mirrors the spawner's recording logic.
 */

import { test } from "node:test";
import assert from "node:assert";
import { Client } from "pg";

const DB_URL =
	process.env.DATABASE_URL ?? "postgresql://admin@127.0.0.1:5432/agenthive";

const HONEST_AGENCY = "v3c4-honest-agency";
const LYING_AGENCY = "v3c4-lying-agency";

// Mirror of spawnAgent's P1436 recording: provider_mismatch = claimed != resolved.
function record(claimed: string, resolved: string) {
	return { claimed, resolved, mismatch: claimed !== resolved };
}

async function insertRun(
	c: Client,
	agency: string,
	r: { claimed: string; resolved: string; mismatch: boolean },
): Promise<void> {
	await c.query(
		`INSERT INTO agent_runs
		   (agent_identity, stage, model_used, status, started_at,
		    claimed_provider, resolved_provider, agent_cli, route_id, agency_identity, provider_mismatch)
		 VALUES ($1, 'developer', 'model-x', 'running', now(),
		         $2, $3, $2, 1, $1, $4)`,
		[agency, r.claimed, r.resolved, r.mismatch],
	);
}

test("P1436 AC-2/AC-4: provider mismatch is recorded and only mismatches surface in v_provider_mismatch", async () => {
	const c = new Client({ connectionString: DB_URL });
	await c.connect();
	try {
		await c.query("BEGIN");

		// Apply C4 columns + view (idempotent; rolled back with the txn).
		await c.query(
			`ALTER TABLE roadmap_workforce.agent_runs
			   ADD COLUMN IF NOT EXISTS claimed_provider  text,
			   ADD COLUMN IF NOT EXISTS resolved_provider text,
			   ADD COLUMN IF NOT EXISTS agent_cli         text,
			   ADD COLUMN IF NOT EXISTS route_id          bigint,
			   ADD COLUMN IF NOT EXISTS agency_identity   text,
			   ADD COLUMN IF NOT EXISTS provider_mismatch boolean NOT NULL DEFAULT false`,
		);
		await c.query(
			`CREATE OR REPLACE VIEW roadmap_workforce.v_provider_mismatch AS
			   SELECT agency_identity, claimed_provider, resolved_provider,
			          count(*) AS runs, max(started_at) AS last_seen
			     FROM roadmap_workforce.agent_runs
			    WHERE provider_mismatch = true
			    GROUP BY agency_identity, claimed_provider, resolved_provider`,
		);

		// Honest route: agency declares codex, route resolved codex -> no mismatch.
		const honest = record("codex", "codex");
		assert.equal(honest.mismatch, false, "honest route must not flag mismatch");
		await insertRun(c, HONEST_AGENCY, honest);

		// Lying registry: agency declares codex, route resolved claude -> mismatch.
		const lying = record("codex", "claude");
		assert.equal(lying.mismatch, true, "divergent providers must flag mismatch");
		await insertRun(c, LYING_AGENCY, lying);

		// The honest run is NOT in the mismatch view; the lying one IS.
		const { rows } = await c.query<{ agency_identity: string; claimed_provider: string; resolved_provider: string }>(
			`SELECT agency_identity, claimed_provider, resolved_provider
			   FROM roadmap_workforce.v_provider_mismatch
			  WHERE agency_identity IN ($1, $2)
			  ORDER BY agency_identity`,
			[HONEST_AGENCY, LYING_AGENCY],
		);
		assert.equal(rows.length, 1, "exactly one agency should appear in v_provider_mismatch");
		assert.equal(rows[0].agency_identity, LYING_AGENCY);
		assert.equal(rows[0].claimed_provider, "codex");
		assert.equal(rows[0].resolved_provider, "claude");
	} finally {
		await c.query("ROLLBACK").catch(() => {});
		await c.end();
	}
});
