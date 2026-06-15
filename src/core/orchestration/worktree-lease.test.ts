import assert from "node:assert";
import { describe, test } from "node:test";
import {
	claimWorktreeForDispatch,
	type QueryFn,
	reapExpiredWorktreeLeases,
	registerWorktree,
	releaseWorktreeLease,
} from "./worktree-lease.ts";

/**
 * P1445 AC-2: the worktree allocator hands out each free worktree to AT MOST
 * one concurrent claimer. These are env-gated live-DB tests — they run against
 * the real roadmap.worktree_lease table inside a SAVEPOINT that is always
 * rolled back, so they never pollute live data.
 *
 *   AGENTHIVE_RESOLVER_DB_TEST=1 node --import jiti/register --test worktree-lease.test.ts
 */
const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";

describe(
	"claimWorktreeForDispatch concurrency (P1445 AC-2)",
	{ skip: !DB_TEST },
	() => {
		async function withRollback(
			fn: (query: QueryFn, raw: import("pg").Client) => Promise<void>,
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
				const query: QueryFn = (sql, params) =>
					client.query(sql, params as unknown[]) as never;
				await fn(query, client);
			} finally {
				await client.query("ROLLBACK").catch(() => {});
				await client.end();
			}
		}

		test("M free worktrees + K>M serial claims → exactly M succeed, all distinct", async () => {
			await withRollback(async (query) => {
				const M = 4;
				const K = 10;
				const prefix = "p1445-test-serial-";
				for (let i = 0; i < M; i++) {
					await registerWorktree(query, `${prefix}${i}`, `/tmp/${prefix}${i}`);
				}
				const claimed: string[] = [];
				for (let i = 0; i < K; i++) {
					const lease = await claimWorktreeForDispatch(query, {
						agentIdentity: `claimer-${i}`,
					});
					if (lease) claimed.push(lease.worktree_name);
				}
				// Exactly M claims succeed; the rest get null (pool exhausted).
				assert.equal(claimed.length, M, "exactly M claims succeed");
				assert.equal(new Set(claimed).size, M, "no worktree handed out twice");
			});
		});

		test("concurrent claims on the same pool never double-allocate (SKIP LOCKED)", async () => {
			// Each claimer needs its OWN connection so the row locks actually contend.
			const { Client } = await import("pg");
			const M = 5;
			const K = 12;
			const prefix = "p1445-test-concurrent-";

			const setup = new Client({
				host: process.env.PGHOST || "127.0.0.1",
				port: parseInt(process.env.PGPORT || "5432", 10),
				user: process.env.PGUSER || "admin",
				password: process.env.PGPASSWORD,
				database: process.env.PGDATABASE || "agenthive",
			});
			await setup.connect();
			try {
				const names: string[] = [];
				for (let i = 0; i < M; i++) {
					const name = `${prefix}${i}`;
					names.push(name);
					await setup.query(
						`INSERT INTO roadmap.worktree_lease (worktree_name, worktree_path, released_at)
					 VALUES ($1, $2, NOW()) ON CONFLICT (worktree_name) DO UPDATE SET released_at = NOW()`,
						[name, `/tmp/${name}`],
					);
				}

				// Fire K real concurrent claims on K independent connections.
				const claimers = Array.from({ length: K }, async (_unused, i) => {
					const c = new Client({
						host: process.env.PGHOST || "127.0.0.1",
						port: parseInt(process.env.PGPORT || "5432", 10),
						user: process.env.PGUSER || "admin",
						password: process.env.PGPASSWORD,
						database: process.env.PGDATABASE || "agenthive",
					});
					await c.connect();
					try {
						const query: QueryFn = (sql, params) =>
							c.query(sql, params as unknown[]) as never;
						const lease = await claimWorktreeForDispatch(query, {
							agentIdentity: `concurrent-${i}`,
						});
						return lease?.worktree_name ?? null;
					} finally {
						await c.end();
					}
				});

				const results = (await Promise.all(claimers)).filter(
					(n): n is string => n != null,
				);
				assert.equal(results.length, M, "exactly M concurrent claims win");
				assert.equal(
					new Set(results).size,
					M,
					"SKIP LOCKED guarantees no worktree double-allocated under contention",
				);
			} finally {
				// Cleanup: remove only the rows this test created.
				await setup.query(
					`DELETE FROM roadmap.worktree_lease WHERE worktree_name LIKE $1`,
					[`${prefix}%`],
				);
				await setup.end();
			}
		});

		test("release returns a worktree to the free pool; reap frees expired leases", async () => {
			await withRollback(async (query) => {
				await registerWorktree(query, "p1445-test-rel", "/tmp/p1445-test-rel");

				const a = await claimWorktreeForDispatch(query, { agentIdentity: "A" });
				assert.ok(a, "first claim succeeds");
				// Pool now empty.
				const b = await claimWorktreeForDispatch(query, { agentIdentity: "B" });
				assert.equal(b, null, "no free worktree while claimed");

				await releaseWorktreeLease(query, "p1445-test-rel");
				const c = await claimWorktreeForDispatch(query, { agentIdentity: "C" });
				assert.ok(c, "claim succeeds again after release");
				assert.equal(c?.worktree_name, "p1445-test-rel");

				// Force-expire then reap.
				await query(
					`UPDATE roadmap.worktree_lease SET expires_at = NOW() - interval '1 hour'
				 WHERE worktree_name = 'p1445-test-rel'`,
				);
				const freed = await reapExpiredWorktreeLeases(query);
				assert.ok(freed >= 1, "reaper frees the expired lease");
				const d = await claimWorktreeForDispatch(query, { agentIdentity: "D" });
				assert.ok(d, "reaped worktree is claimable again");
			});
		});
	},
);
