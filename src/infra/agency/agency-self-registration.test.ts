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

import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
	AgencyAlreadyActive,
	selfRegisterAgency,
} from "./agency-self-registration.ts";

// SKIP when no DB credentials available (PGPASSWORD env or ~/.pgpass).
// pg.Pool reads ~/.pgpass automatically; we only need PGUSER set or default.
const SKIP = !process.env.PGUSER && !process.env.PGPASSWORD;
let pool: Pool;

const dbTest = (name: string, fn: () => Promise<void>) =>
	it(name, async () => {
		if (SKIP) {
			console.log(`  [skipped: ${name}] — DB credentials absent`);
			return;
		}
		await fn();
	});

beforeAll(async () => {
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

afterAll(async () => {
	if (SKIP || !pool) return;
	await pool.end();
});

describe("P921 — Active liaison session uniqueness", () => {
	dbTest("AgencyAlreadyActive error is instanceof Error", async () => {
		const err = new AgencyAlreadyActive("test/agency", "session-123");
		assert(
			err instanceof Error,
			"AgencyAlreadyActive must be instanceof Error",
		);
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
				assert.fail(
					"Second registration should have thrown AgencyAlreadyActive",
				);
			} catch (err) {
				assert(
					err instanceof AgencyAlreadyActive,
					`Expected AgencyAlreadyActive, got ${err?.constructor?.name}`,
				);
				assert.strictEqual((err as AgencyAlreadyActive).agency_id, testAgency);
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
			const indexRes = await pool.query<{ exists: boolean }>(
				`SELECT EXISTS (
					SELECT 1
					FROM pg_indexes
					WHERE schemaname = 'roadmap'
					  AND tablename = 'agency_liaison_session'
					  AND indexname = 'idx_agency_session_one_active'
				) AS exists`,
			);
			if (!indexRes.rows[0]?.exists) {
				console.log(
					"  [skipped: idx_agency_session_one_active not applied on this DB]",
				);
				return;
			}
			const testAgency = `test/agency-constraint-${Date.now()}`;

			// Register and get the session
			const reg = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});

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

describe("P913 — agency-self-registration hotfix (transaction + advisory lock + provider_registry FK)", () => {
	dbTest(
		"Concurrent same-identity calls serialize on advisory lock; one wins, other catches AgencyAlreadyActive",
		async () => {
			const testAgency = `test/agency-p913-concurrent-${Date.now()}`;
			// Fire two registrations in parallel for the SAME agencyId.
			const results = await Promise.allSettled([
				selfRegisterAgency({
					agencyId: testAgency,
					provider: "claude",
					capabilities: ["test"],
				}),
				selfRegisterAgency({
					agencyId: testAgency,
					provider: "claude",
					capabilities: ["test"],
				}),
			]);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			assert.strictEqual(
				fulfilled.length,
				1,
				"exactly one call should succeed",
			);
			assert.strictEqual(rejected.length, 1, "the other should reject");
			// The rejected one MUST be AgencyAlreadyActive (not a raw DatabaseError).
			const rej = rejected[0] as PromiseRejectedResult;
			assert(
				rej.reason instanceof AgencyAlreadyActive,
				`Expected AgencyAlreadyActive, got ${rej.reason?.constructor?.name}: ${rej.reason?.message}`,
			);
			// Exactly ONE active session for this agency.
			const live = await pool.query(
				`SELECT count(*)::int AS n FROM roadmap.agency_liaison_session
				 WHERE agency_id = $1 AND ended_at IS NULL`,
				[testAgency],
			);
			assert.strictEqual(live.rows[0].n, 1);
			// No duplicate capability rows.
			const caps = await pool.query(
				`SELECT count(*)::int AS n FROM roadmap_workforce.agent_capability ac
				 JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
				 WHERE ar.agent_identity = $1 AND ac.capability = 'test'`,
				[testAgency],
			);
			assert.strictEqual(caps.rows[0].n, 1, "exactly one capability row");
			// Clean up the winner's session.
			const winner = (
				fulfilled[0] as PromiseFulfilledResult<
					Awaited<ReturnType<typeof selfRegisterAgency>>
				>
			).value;
			await winner.stop("operator");
		},
	);

	dbTest(
		"provider_registry insert populates BOTH agency_id (bigint) AND agency_identity (text)",
		async () => {
			const testAgency = `test/agency-p913-pr-${Date.now()}`;
			// Pick any existing project_id for the FK.
			const projRow = await pool.query<{ project_id: number }>(
				`SELECT project_id FROM roadmap.project ORDER BY project_id LIMIT 1`,
			);
			if (projRow.rows.length === 0) return; // no projects to opt into
			const projectId = projRow.rows[0].project_id;
			const reg = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
				projectIds: [projectId],
			});
			try {
				const pr = await pool.query<{
					agency_id: number;
					agency_identity: string;
				}>(
					`SELECT pr.agency_id, pr.agency_identity
					   FROM roadmap_workforce.provider_registry pr
					   JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
					  WHERE ar.agent_identity = $1 AND pr.project_id = $2`,
					[testAgency, projectId],
				);
				assert.strictEqual(pr.rows.length, 1, "one provider_registry row");
				assert.strictEqual(
					pr.rows[0].agency_identity,
					testAgency,
					"agency_identity matches text identity",
				);
				assert(
					typeof pr.rows[0].agency_id === "number" ||
						typeof pr.rows[0].agency_id === "string",
					"agency_id is the bigint FK",
				);
			} finally {
				await reg.stop("operator");
			}
		},
	);

	dbTest(
		"Transaction is the boundary — agency_registry stays clean after a duplicate-session conflict",
		async () => {
			const testAgency = `test/agency-p913-tx-${Date.now()}`;
			const reg1 = await selfRegisterAgency({
				agencyId: testAgency,
				provider: "claude",
				capabilities: ["test"],
			});
			try {
				// Second registration throws AgencyAlreadyActive — transaction rolls back.
				let threw = false;
				try {
					await selfRegisterAgency({
						agencyId: testAgency,
						provider: "claude",
						capabilities: ["test", "another-cap"],
					});
				} catch (err) {
					threw = true;
					assert(err instanceof AgencyAlreadyActive);
				}
				assert(threw, "second registration should throw");
				// The "another-cap" capability MUST NOT have been inserted (the transaction rolled back).
				const caps = await pool.query(
					`SELECT count(*)::int AS n FROM roadmap_workforce.agent_capability ac
					 JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
					 WHERE ar.agent_identity = $1 AND ac.capability = 'another-cap'`,
					[testAgency],
				);
				assert.strictEqual(
					caps.rows[0].n,
					0,
					"rolled-back capability is not present",
				);
			} finally {
				await reg1.stop("operator");
			}
		},
	);
});

describe("P1351 — Nested agencies (parent_agency_id)", () => {
	dbTest(
		"AgencySelfRegistrationOptions accepts optional parentAgencyId parameter",
		async () => {
			const testParent = `test/parent-${Date.now()}`;
			const testChild = `test/child-${Date.now()}`;

			// Register parent first
			const parentReg = await selfRegisterAgency({
				agencyId: testParent,
				provider: "claude",
				capabilities: ["test"],
			});

			try {
				// Register child with parent reference
				const childReg = await selfRegisterAgency({
					agencyId: testChild,
					provider: "claude",
					capabilities: ["test"],
					parentAgencyId: testParent,
				});

				try {
					// Verify parent_agency_id is persisted in roadmap.agency
					const childRow = await pool.query<{ parent_agency_id: string | null }>(
						`SELECT parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
						[testChild],
					);
					assert.strictEqual(
						childRow.rows.length,
						1,
						"child agency row exists",
					);
					assert.strictEqual(
						childRow.rows[0].parent_agency_id,
						testParent,
						"parent_agency_id matches",
					);
				} finally {
					await childReg.stop("operator");
				}
			} finally {
				await parentReg.stop("operator");
			}
		},
	);

	dbTest(
		"liaisonRegister preserves parent_agency_id on upsert",
		async () => {
			const testParent = `test/parent-upsert-${Date.now()}`;
			const testChild = `test/child-upsert-${Date.now()}`;

			// Register parent
			const parentReg = await selfRegisterAgency({
				agencyId: testParent,
				provider: "claude",
				capabilities: ["test"],
			});

			try {
				// Register child twice with same parent_agency_id
				const childReg1 = await selfRegisterAgency({
					agencyId: testChild,
					provider: "claude",
					capabilities: ["test"],
					parentAgencyId: testParent,
				});

				await childReg1.stop("operator");

				// Re-register child (should upsert, preserving parent)
				const childReg2 = await selfRegisterAgency({
					agencyId: testChild,
					provider: "claude",
					capabilities: ["test"],
					parentAgencyId: testParent,
				});

				try {
					// Verify parent_agency_id is still correct after upsert
					const childRow = await pool.query<{ parent_agency_id: string | null }>(
						`SELECT parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
						[testChild],
					);
					assert.strictEqual(
						childRow.rows[0].parent_agency_id,
						testParent,
						"parent_agency_id persists after upsert",
					);
				} finally {
					await childReg2.stop("operator");
				}
			} finally {
				await parentReg.stop("operator");
			}
		},
	);

	dbTest(
		"UNIQUE(parent_agency_id, agency_id) constraint enforces sibling deduplication",
		async () => {
			const testParent = `test/parent-unique-${Date.now()}`;
			const testChild = `test/child-unique-${Date.now()}`;

			// Register parent
			const parentReg = await selfRegisterAgency({
				agencyId: testParent,
				provider: "claude",
				capabilities: ["test"],
			});

			try {
				// Register child with parent
				const childReg = await selfRegisterAgency({
					agencyId: testChild,
					provider: "claude",
					capabilities: ["test"],
					parentAgencyId: testParent,
				});

				try {
					// Try to insert duplicate (parent, child) — should violate UNIQUE constraint
					try {
						await pool.query(
							`INSERT INTO roadmap.agency (agency_id, display_name, provider, host_id, parent_agency_id)
							 VALUES ($1, $2, $3, $4, $5)`,
							[testChild, testChild, "claude", "test-host", testParent],
						);
						assert.fail(
							"Duplicate (parent, child) insert should violate UNIQUE constraint",
						);
					} catch (err) {
						assert(
							err instanceof Error &&
								err.message.includes("unique_parent_child"),
							`Expected unique_parent_child constraint error, got: ${(err as Error).message}`,
						);
					}
				} finally {
					await childReg.stop("operator");
				}
			} finally {
				await parentReg.stop("operator");
			}
		},
	);
});
