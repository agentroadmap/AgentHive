#!/usr/bin/env node
/**
 * P472 — Principal Identity Migration Script (AC#106)
 *
 * Migrates `roadmap_workforce.agent_registry.public_key` rows into
 * `roadmap.principal_identity`.  Aborts if collisions are detected:
 * same agent_identity mapped to different public_keys.
 *
 * Usage:
 *   node --import jiti/register scripts/migrate-principal-identity.ts [--dry-run]
 */

import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";

// ── Env / pool setup ─────────────────────────────────────────────────────────

function loadEnvPassword(): void {
	if (process.env.PGPASSWORD) return;
	for (const f of [".env", ".env.agent"]) {
		if (!existsSync(f)) continue;
		const m = readFileSync(f, "utf8").match(/^PGPASSWORD=(.+)$/m);
		if (m) {
			process.env.PGPASSWORD = m[1].trim();
			return;
		}
	}
}

loadEnvPassword();

const pool = new Pool({
	host: process.env.PGHOST ?? "127.0.0.1",
	port: Number(process.env.PGPORT ?? 5432),
	user: process.env.PGUSER ?? "xiaomi",
	database: process.env.PGDATABASE ?? "agenthive",
	connectionTimeoutMillis: 5000,
});

const DRY_RUN = process.argv.includes("--dry-run");

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentRow {
	agent_identity: string;
	public_key: string | null;
	key_rotated_at: Date | null;
	created_at: Date | null;
	id: number;
}

interface CollisionRow {
	agent_identity: string;
	distinct_key_count: string;
	keys: string[];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
	const client = await pool.connect();
	try {
		console.log("P472 migration: checking for agent_registry.public_key collisions (AC#106)…");

		// ── AC#106: Collision audit ──────────────────────────────────────────
		const collisionResult = await client.query<CollisionRow>(
			`SELECT agent_identity,
			        count(DISTINCT public_key)::text          AS distinct_key_count,
			        array_agg(DISTINCT public_key ORDER BY public_key) AS keys
			   FROM roadmap_workforce.agent_registry
			  WHERE public_key IS NOT NULL
			  GROUP BY agent_identity
			  HAVING count(DISTINCT public_key) > 1`,
		);

		if (collisionResult.rows.length > 0) {
			console.error(
				`\n✗ Migration BLOCKED — ${collisionResult.rows.length} collision(s) found:\n`,
			);
			for (const row of collisionResult.rows) {
				console.error(
					`  agent_identity=${row.agent_identity}  keys=${row.keys.join(", ")}`,
				);
			}
			console.error(
				"\nResolve collisions in agent_registry before re-running.\n" +
				"See roadmap.v_principal_migration_collisions for details.\n",
			);
			process.exit(1);
		}

		console.log("✓ No collisions detected.");

		// ── Count rows to migrate ─────────────────────────────────────────────
		const countResult = await client.query<{ cnt: string }>(
			`SELECT count(*)::text AS cnt
			   FROM roadmap_workforce.agent_registry
			  WHERE public_key IS NOT NULL`,
		);
		const rowCount = parseInt(countResult.rows[0]?.cnt ?? "0", 10);
		console.log(`  ${rowCount} agent_registry rows with public_key to migrate.`);

		if (rowCount === 0) {
			console.log("Nothing to migrate.");
			return;
		}

		if (DRY_RUN) {
			console.log("\n[dry-run] Would migrate the following agents:");
			const preview = await client.query<AgentRow>(
				`SELECT agent_identity, left(public_key, 40) AS public_key, key_rotated_at, created_at, id
				   FROM roadmap_workforce.agent_registry
				  WHERE public_key IS NOT NULL
				  ORDER BY id
				  LIMIT 20`,
			);
			for (const row of preview.rows) {
				console.log(
					`  agent:${row.agent_identity}  key=${row.public_key}…  id=${row.id}`,
				);
			}
			if (rowCount > 20) console.log(`  … and ${rowCount - 20} more.`);
			console.log("\n[dry-run] No changes written.");
			return;
		}

		// ── Migration ─────────────────────────────────────────────────────────
		await client.query("BEGIN");
		try {
			const insertResult = await client.query(
				`INSERT INTO roadmap.principal_identity (
				   principal_id,
				   principal_kind,
				   credential_kind,
				   public_credential,
				   issued_at,
				   metadata
				 )
				 SELECT
				   'agent:' || ar.agent_identity,
				   'agent',
				   'ed25519',
				   ar.public_key,
				   COALESCE(ar.key_rotated_at, ar.created_at, now()),
				   jsonb_build_object(
				     'migrated_from',    'agent_registry',
				     'agent_identity',   ar.agent_identity,
				     'legacy_row_id',    ar.id,
				     'migrated_at',      now()
				   )
				 FROM roadmap_workforce.agent_registry ar
				 WHERE ar.public_key IS NOT NULL
				 ON CONFLICT (principal_id) DO UPDATE SET
				   public_credential = EXCLUDED.public_credential,
				   metadata = roadmap.principal_identity.metadata || EXCLUDED.metadata`,
			);
			console.log(`✓ Inserted/updated ${insertResult.rowCount} principal rows.`);

			// ── Migrate authority_chain → authority_grant ──────────────────────
			const grantResult = await client.query(
				`INSERT INTO roadmap.authority_grant (
				   grantor_id,
				   grantee_id,
				   scope_category,
				   scope_ref,
				   authority_level,
				   can_override,
				   reason,
				   expires_at,
				   created_at,
				   updated_at
				 )
				 SELECT
				   'agent:' || ac.granted_by,
				   'agent:' || ac.authority_agent,
				   ac.scope_category,
				   ac.scope_ref,
				   ac.authority_level,
				   ac.can_override,
				   ac.reason,
				   ac.expires_at,
				   ac.created_at,
				   ac.updated_at
				 FROM roadmap_workforce.authority_chain ac
				 WHERE EXISTS (
				   SELECT 1 FROM roadmap.principal_identity
				    WHERE principal_id = 'agent:' || ac.granted_by
				 )
				 AND EXISTS (
				   SELECT 1 FROM roadmap.principal_identity
				    WHERE principal_id = 'agent:' || ac.authority_agent
				 )
				 ON CONFLICT (grantor_id, grantee_id, scope_category, scope_ref)
				 DO NOTHING`,
			);
			console.log(`✓ Migrated ${grantResult.rowCount} authority_chain → authority_grant rows.`);

			await client.query("COMMIT");
			console.log("\n✓ Migration complete.");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	} finally {
		client.release();
		await pool.end();
	}
}

run().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
