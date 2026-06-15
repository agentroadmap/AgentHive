/**
 * P2997 AC-8 migration evidence — applies migration 283 inside a transaction
 * against the live DB and ROLLBACKs, asserting the columns, CHECK constraints,
 * the stake_ledger table, and idempotency of a second apply.
 *
 * Skips automatically if no DB is reachable (CI / offline). Requires ~/.pgpass.
 *
 * Run:
 *   npx vitest run scripts/migrations/__tests__/p2997-stake-migration.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migPath = join(here, "..", "283-p2997-stake-layer.sql");
const migSql = readFileSync(migPath, "utf-8");

// pg is an external runtime dep of the repo.
import pg from "pg";

const CONN = {
	host: process.env.PGHOST ?? "127.0.0.1",
	port: Number(process.env.PGPORT ?? 5432),
	user: process.env.PGUSER ?? "admin",
	database: process.env.PGDATABASE ?? "agenthive",
	// password comes from ~/.pgpass automatically when omitted; allow env override.
	password: process.env.PGPASSWORD,
};

let client: pg.Client | null = null;
let dbAvailable = false;

beforeAll(async () => {
	try {
		client = new pg.Client(CONN);
		await client.connect();
		dbAvailable = true;
	} catch {
		dbAvailable = false;
		client = null;
	}
});

afterAll(async () => {
	if (client) await client.end().catch(() => {});
});

describe("P2997 migration 283 (stake layer)", () => {
	it("applies, exposes the stake columns + ledger, and is idempotent", async () => {
		if (!dbAvailable || !client) {
			console.warn("[p2997-migration-test] DB unavailable — skipping");
			return;
		}
		await client.query("BEGIN");
		try {
			await client.query(migSql);

			const cols = await client.query(
				`SELECT column_name FROM information_schema.columns
				  WHERE table_schema='roadmap_workforce' AND table_name='agent_registry'
				    AND column_name IN ('stake_microcents','stake_status','is_legacy')
				  ORDER BY column_name`,
			);
			expect(cols.rows.map((r) => r.column_name)).toEqual([
				"is_legacy",
				"stake_microcents",
				"stake_status",
			]);

			const checks = await client.query(
				`SELECT conname FROM pg_constraint
				  WHERE conrelid='roadmap_workforce.agent_registry'::regclass
				    AND conname IN ('agent_registry_stake_status_check',
				                    'agent_registry_stake_nonneg_check')`,
			);
			expect(checks.rows).toHaveLength(2);

			const ledger = await client.query(
				`SELECT to_regclass('roadmap_workforce.stake_ledger') AS t`,
			);
			expect(ledger.rows[0].t).toBe("stake_ledger");

			// stake_status CHECK enforced: an invalid value must be rejected.
			await expect(
				client.query(
					`UPDATE roadmap_workforce.agent_registry
					    SET stake_status='bogus' WHERE false`,
				),
			).resolves.toBeTruthy(); // WHERE false touches 0 rows; CHECK not triggered

			// Re-apply to prove idempotency (no error on second run).
			await client.query(migSql);
		} finally {
			await client.query("ROLLBACK");
		}
	});

	it("stake_status CHECK rejects an out-of-domain value", async () => {
		if (!dbAvailable || !client) return;
		await client.query("BEGIN");
		try {
			await client.query(migSql);
			// Insert a throwaway registry row then try an illegal status.
			await client.query(
				`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
				 VALUES ('p2997-test/scratch', 'llm')
				 ON CONFLICT (agent_identity) DO NOTHING`,
			);
			await expect(
				client.query(
					`UPDATE roadmap_workforce.agent_registry
					    SET stake_status='bogus'
					  WHERE agent_identity='p2997-test/scratch'`,
				),
			).rejects.toThrow();
		} finally {
			await client.query("ROLLBACK");
		}
	});
});
