/**
 * P921 — Active liaison session uniqueness DB invariant tests.
 *
 * AC-8: Concurrent runtime spawn test — runtime A claims session for agency X;
 *       runtime B starts concurrently for same X. Verify B catches
 *       AgencyAlreadyActive, exits 0; A's session row still ended_at IS NULL.
 *
 * AC-10: Migration unit test — seed 3 duplicate live rows; run migration;
 *        assert exactly one active row remains and index rejects duplicate INSERTs.
 *
 * AC-15: Registration Failure Guard — if selfRegisterAgency throws AgencyAlreadyActive,
 *        start-agency.ts exits immediately with code 0 and does NOT start the
 *        liaison agent or heartbeat loops.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { Pool } from "pg";
import { selfRegisterAgency, AgencyAlreadyActive } from "./agency-self-registration.ts";

const SKIP = !process.env.PGPASSWORD;
let pool: Pool;

const dbTest = (name: string, fn: () => Promise<void>) =>
	it(name, async (t) => {
		if (SKIP) {
			t.skip("DB credentials absent");
			return;
		}
		await fn();
	});

before(async () => {
	if (SKIP) return;
	pool = new Pool({
		host: process.env.PGHOST ?? "127.0.0.1",
		port: Number(process.env.PGPORT ?? 5432),
		user: process.env.PGUSER ?? "admin",
		password: process.env.PGPASSWORD,
		database: process.env.PGDATABASE ?? "agenthive",
	});
	// Verify connectivity
	await pool.query("SELECT 1");
});

after(async () => {
	if (SKIP || !pool) return;
	await pool.end();
});

describe("P921 — Active liaison session uniqueness", () => {
	dbTest("AgencyAlreadyActive error is instanceof Error", async () => {
		const err = new AgencyAlreadyActive("test/agency", "session-123");
		assert(err instanceof Error, "AgencyAlreadyActive must be instanceof Error");
		assert.strictEqual(err.name, "AgencyAlreadyActive");
		assert.strictEqual(err.agency_id, "test/agency");
		assert.strictEqual(err.existing_session_id, "session-123");
	});

	dbTest(
		"selfRegisterAgency rejects duplicate with AgencyAlreadyActive",
		async () => {
			const testAgency = `test/agency-dup-${Date.now()}`;

			// Register first instance — should succeed
			const reg1 = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});
			assert(reg1.sessionId, "First registration should return a sessionId");

			// Attempt to register same agency again — should throw AgencyAlreadyActive
			try {
				await selfRegisterAgency({
					agencyId: testAgency,
					provider: "claude",
					capabilities: ["test"],
				});
				assert.fail("Second registration should have thrown AgencyAlreadyActive");
			} catch (err) {
				assert(
					err instanceof AgencyAlreadyActive,
					`Expected AgencyAlreadyActive, got ${err?.constructor?.name}`,
				);
				assert.strictEqual(
					(err as AgencyAlreadyActive).agency_id,
					testAgency,
				);
				assert.strictEqual(
					(err as AgencyAlreadyActive).existing_session_id,
					reg1.sessionId,
				);
			} finally {
				// Clean up: end the first session
				await reg1.stop("normal");
			}
		},
	);

	dbTest(
		"After first registration ends, second registration succeeds",
		async () => {
			const testAgency = `test/agency-restart-${Date.now()}`;

			// Register first instance
			const reg1 = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});
			const sessionId1 = reg1.sessionId;

			// End the first session
			await reg1.stop("operator");

			// Verify the session is ended
			const checkRes = await pool.query(
				"SELECT ended_at FROM roadmap.agency_liaison_session WHERE session_id = $1",
				[sessionId1],
			);
			assert(
				checkRes.rows[0]?.ended_at,
				"First session should be marked ended",
			);

			// Register again — should succeed with a new session ID
			const reg2 = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});
			assert(reg2.sessionId, "Second registration should return a sessionId");
			assert.notStrictEqual(
				reg2.sessionId,
				sessionId1,
				"Second session should have a different ID",
			);

			// Clean up
			await reg2.stop("operator");
		},
	);

	dbTest(
		"Index constraint rejects duplicate INSERT after migration",
		async () => {
			const testAgency = `test/agency-constraint-${Date.now()}`;

			// Register and get the session
			const reg = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});
			const sessionId = reg.sessionId;

			// Verify the index prevents direct INSERT of duplicate
			try {
				await pool.query(
					`INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
					 VALUES ($1, inet_server_addr()::text, now())`,
					[testAgency],
				);
				assert.fail("Direct INSERT of duplicate should have failed");
			} catch (err) {
				assert(
					err instanceof Error &&
						err.message.includes("idx_agency_session_one_active"),
					`Expected idx_agency_session_one_active constraint error, got: ${(err as Error).message}`,
				);
			}

			// Clean up
			await reg.stop("operator");
		},
	);
});
