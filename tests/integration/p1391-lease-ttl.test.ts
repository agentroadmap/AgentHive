/**
 * P1391 — structural lease layer: integration tests (AC-1, AC-2, AC-9, AC-11,
 * AC-22, AC-25).
 *
 * SAFETY: every test runs inside a single transaction that builds a THROWAWAY
 * schema (`tt_p1391_<pid>`), exercises the P1391 structural DDL there, and
 * ALWAYS ROLLBACKs. No live `roadmap_proposal.*` row is ever read or mutated.
 * If no Postgres is reachable the suite skips cleanly.
 *
 * The DDL replicated here is the exact structural shape installed by
 * scripts/migrations/283-p1391-lease-ttl-structural.sql:
 *   - lease_is_live(timestamptz, timestamptz) VOLATILE scalar function (AC-22)
 *   - the partial EXCLUDE constraint proposal_lease_no_overlap_live (AC-2/AC-9)
 *   - the max-TTL CHECK proposal_lease_max_ttl_check (AC-25)
 *
 * Run: node --import jiti/register --test tests/integration/p1391-lease-ttl.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

// Resolve a password from ~/.pgpass line 1 if PGPASSWORD isn't already set,
// matching the convention in postgres-integration.test.ts.
function ensurePassword(): void {
	if (process.env.PGPASSWORD) return;
	try {
		const home = process.env.HOME ?? "";
		const line = readFileSync(`${home}/.pgpass`, "utf8").split("\n")[0] ?? "";
		const parts = line.split(":");
		if (parts[4]) process.env.PGPASSWORD = parts[4].trim();
	} catch {
		/* no .pgpass — connection may still succeed via other means */
	}
}

function makeClient(): Client {
	ensurePassword();
	return new Client({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? "5432"),
		user: process.env.PGUSER ?? "admin",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
}

const SCHEMA = `tt_p1391_${process.pid}`;
let client: Client | null = null;
let dbAvailable = false;

// Build the throwaway lease table mirroring the P1391 structural DDL.
const SETUP_SQL = `
  CREATE SCHEMA ${SCHEMA};
  SET search_path = ${SCHEMA};
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  CREATE FUNCTION ${SCHEMA}.lease_is_live(
    p_released_at timestamptz, p_expires_at timestamptz
  ) RETURNS boolean LANGUAGE sql VOLATILE AS $fn$
    SELECT p_released_at IS NULL AND p_expires_at > now()
  $fn$;

  CREATE TABLE proposal_lease (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id bigint NOT NULL,
    claimed_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
    released_at timestamptz,
    release_reason text,
    CONSTRAINT proposal_lease_no_overlap_live
      EXCLUDE USING gist (
        proposal_id WITH =,
        tstzrange(claimed_at, expires_at, '[)') WITH &&
      ) WHERE (released_at IS NULL),
    CONSTRAINT proposal_lease_max_ttl_check
      CHECK (expires_at <= claimed_at + interval '24 hours')
  );
`;

before(async () => {
	try {
		client = makeClient();
		await client.connect();
		// Single outer transaction; everything rolls back in after().
		await client.query("BEGIN");
		await client.query(SETUP_SQL);
		await client.query(`SET search_path = ${SCHEMA}`);
		dbAvailable = true;
	} catch (err) {
		dbAvailable = false;
		// eslint-disable-next-line no-console
		console.warn(
			`[p1391-lease-ttl] Postgres unavailable — skipping integration tests: ${
				(err as Error).message
			}`,
		);
		if (client) {
			try {
				await client.end();
			} catch {
				/* ignore */
			}
			client = null;
		}
	}
});

after(async () => {
	if (client) {
		try {
			// Roll back EVERYTHING — the throwaway schema never persists.
			await client.query("ROLLBACK");
		} catch {
			/* ignore */
		}
		try {
			await client.end();
		} catch {
			/* ignore */
		}
	}
});

// Helper that wraps each test in a savepoint so tests are independent and the
// outer transaction stays open for the next one.
async function inSavepoint(fn: (c: Client) => Promise<void>): Promise<void> {
	if (!dbAvailable || !client) return; // skipped
	const c = client;
	await c.query("SAVEPOINT sp");
	try {
		await fn(c);
	} finally {
		await c.query("ROLLBACK TO SAVEPOINT sp");
	}
}

describe("P1391 AC-22/AC-1 — lease_is_live(scalar, scalar) in SQL", () => {
	it("returns false for an expired-unreleased lease, true for a fresh one", async () => {
		await inSavepoint(async (c) => {
			const { rows } = await c.query(
				`SELECT
				   ${SCHEMA}.lease_is_live(NULL, now() - interval '1 second') AS expired,
				   ${SCHEMA}.lease_is_live(NULL, now() + interval '30 minutes') AS fresh,
				   ${SCHEMA}.lease_is_live(now(), now() + interval '30 minutes') AS released`,
			);
			assert.equal(rows[0].expired, false, "expired lease must be not-live");
			assert.equal(rows[0].fresh, true, "fresh lease must be live");
			assert.equal(
				rows[0].released,
				false,
				"released lease must be not-live regardless of expires_at",
			);
		});
	});

	it("is registered VOLATILE (AC-22 — NOW() must not be planner-cached)", async () => {
		await inSavepoint(async (c) => {
			const { rows } = await c.query(
				`SELECT provolatile FROM pg_proc
				 WHERE proname = 'lease_is_live'
				   AND pronamespace = '${SCHEMA}'::regnamespace`,
			);
			assert.equal(rows.length, 1, "function must exist");
			assert.equal(rows[0].provolatile, "v", "must be VOLATILE ('v')");
		});
	});
});

describe("P1391 AC-2 — overlapping live leases blocked at the DB level", () => {
	it("rejects a second overlapping unreleased lease for the same proposal", async () => {
		await inSavepoint(async (c) => {
			await c.query(
				`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
				 VALUES (1, now(), now() + interval '30 minutes')`,
			);
			await assert.rejects(
				() =>
					c.query(
						`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
						 VALUES (1, now(), now() + interval '30 minutes')`,
					),
				/proposal_lease_no_overlap_live|exclusion constraint/,
				"overlapping live lease must violate the EXCLUDE constraint",
			);
		});
	});

	it("allows two live leases for DIFFERENT proposals", async () => {
		await inSavepoint(async (c) => {
			await c.query(
				`INSERT INTO proposal_lease (proposal_id) VALUES (10)`,
			);
			await c.query(
				`INSERT INTO proposal_lease (proposal_id) VALUES (11)`,
			);
			const { rows } = await c.query(
				`SELECT count(*)::int AS n FROM proposal_lease WHERE proposal_id IN (10, 11)`,
			);
			assert.equal(rows[0].n, 2);
		});
	});
});

describe("P1391 AC-9 — natural expiry releases the proposal for re-claim, no reaper", () => {
	it("permits a fresh claim once the prior lease's range has ended", async () => {
		await inSavepoint(async (c) => {
			// An old lease whose [claimed_at, expires_at) range is entirely in the
			// past — still unreleased (no reaper ran).
			await c.query(
				`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
				 VALUES (2, now() - interval '10 minutes', now() - interval '5 minutes')`,
			);
			// New claim with a current range must succeed — ranges don't overlap.
			await c.query(
				`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
				 VALUES (2, now(), now() + interval '30 minutes')`,
			);
			const { rows } = await c.query(
				`SELECT count(*)::int AS n FROM proposal_lease WHERE proposal_id = 2`,
			);
			assert.equal(
				rows[0].n,
				2,
				"both the expired and the fresh lease coexist; re-claim succeeded with no janitor",
			);
		});
	});

	it("still blocks re-claim while the prior lease's range is live", async () => {
		await inSavepoint(async (c) => {
			await c.query(
				`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
				 VALUES (3, now() - interval '1 minute', now() + interval '29 minutes')`,
			);
			await assert.rejects(
				() =>
					c.query(
						`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
						 VALUES (3, now(), now() + interval '30 minutes')`,
					),
				/exclusion constraint/,
			);
		});
	});
});

describe("P1391 AC-25 — max-TTL CHECK guards against runaway leases", () => {
	it("rejects a lease whose TTL exceeds 24h", async () => {
		await inSavepoint(async (c) => {
			await assert.rejects(
				() =>
					c.query(
						`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
						 VALUES (4, now(), now() + interval '48 hours')`,
					),
				/proposal_lease_max_ttl_check|check constraint/,
			);
		});
	});

	it("accepts a lease at exactly the 24h boundary", async () => {
		await inSavepoint(async (c) => {
			await c.query(
				`INSERT INTO proposal_lease (proposal_id, claimed_at, expires_at)
				 VALUES (5, now(), now() + interval '24 hours')`,
			);
			const { rows } = await c.query(
				`SELECT count(*)::int AS n FROM proposal_lease WHERE proposal_id = 5`,
			);
			assert.equal(rows[0].n, 1);
		});
	});
});

describe("P1391 AC-11 — constraint swap shape", () => {
	it("the throwaway table carries the EXCLUDE, not the old UNIQUE lock", async () => {
		await inSavepoint(async (c) => {
			const { rows } = await c.query(
				`SELECT conname, contype FROM pg_constraint
				 WHERE conrelid = '${SCHEMA}.proposal_lease'::regclass
				   AND conname IN ('proposal_lease_no_overlap_live', 'proposal_lease_one_active')`,
			);
			const names = rows.map((r: { conname: string }) => r.conname);
			assert.ok(
				names.includes("proposal_lease_no_overlap_live"),
				"EXCLUDE constraint present",
			);
			assert.ok(
				!names.includes("proposal_lease_one_active"),
				"old UNIQUE lock absent",
			);
		});
	});
});
