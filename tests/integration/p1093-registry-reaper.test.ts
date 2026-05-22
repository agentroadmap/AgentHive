/**
 * P1093 — agent_registry stale-row reaper.
 *
 * Requires migration 136 applied. Each test runs in a transaction and rolls
 * back, leaving the shared database untouched.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closePool, getPool } from "../../src/infra/postgres/pool.ts";

async function withTx<T>(fn: (tx: import("pg").PoolClient) => Promise<T>): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		try {
			return await fn(client);
		} finally {
			await client.query("ROLLBACK").catch(() => undefined);
		}
	} finally {
		client.release();
	}
}

after(async () => {
	await closePool();
});

test("fn_reap_stale_registry deletes only stale inactive rows without in-flight work", async () => {
	const tag = `p1093-${process.pid}-${Date.now()}`;
	const staleDelete = `${tag}-stale-delete`;
	const activeKeep = `${tag}-active-keep`;
	const runningKeep = `${tag}-running-keep`;

	await withTx(async (tx) => {
		await tx.query(
			`INSERT INTO roadmap_workforce.agent_registry
			   (agent_identity, agent_type, status, last_seen_at)
			 VALUES
			   ($1, 'tool', 'inactive', now() - interval '45 days'),
			   ($2, 'tool', 'active', now() - interval '45 days'),
			   ($3, 'tool', 'inactive', now() - interval '45 days')`,
			[staleDelete, activeKeep, runningKeep],
		);
		await tx.query(
			`INSERT INTO roadmap_workforce.agent_runs
			   (agent_identity, stage, model_used, status)
			 VALUES ($1, 'DEVELOP', 'test-model', 'running')`,
			[runningKeep],
		);

		const { rows } = await tx.query<{ reaped: number }>(
			`SELECT roadmap_workforce.fn_reap_stale_registry('30 days'::interval, 10) AS reaped`,
		);
		assert.equal(Number(rows[0].reaped), 1);

		const remaining = await tx.query<{ agent_identity: string; status: string }>(
			`SELECT agent_identity, status
			   FROM roadmap_workforce.agent_registry
			  WHERE agent_identity = ANY($1::text[])
			  ORDER BY agent_identity`,
			[[staleDelete, activeKeep, runningKeep]],
		);

		assert.deepEqual(remaining.rows, [
			{ agent_identity: activeKeep, status: "active" },
			{ agent_identity: runningKeep, status: "inactive" },
		]);
	});
});
