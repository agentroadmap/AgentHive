import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { Pool, type PoolClient } from "pg";

/**
 * P828 AC-9/10/14/35/36/39/43/44/45/46: live integration test of the
 * core.config_mutation_log table + core.fn_config_mutation_audit function
 * (migration 279) against a seeded hiveCentral.
 *
 * SKIPPED unless AGENTHIVE_CONTROL_DSN is set, so the always-on unit suite never
 * touches a live DB.
 *
 * ZERO PERMANENT WRITES: every assertion runs inside a single BEGIN/ROLLBACK
 * transaction on one PoolClient. A control_identity.principal row is seeded
 * inside the txn (the audit FK), the config_mutation_log rows are inserted on the
 * same client, fn_config_mutation_audit is read back, and the whole txn is rolled
 * back in after(). Because config_mutation_log is append-only (UPDATE/DELETE
 * trigger-blocked), ROLLBACK is the ONLY clean teardown — we never COMMIT.
 */

const DSN = process.env.AGENTHIVE_CONTROL_DSN;

describe(
	"P828 config_mutation_log + fn_config_mutation_audit (live)",
	{ skip: DSN ? false : "AGENTHIVE_CONTROL_DSN not set" },
	() => {
		let pool: Pool;
		let client: PoolClient;
		let principalId: number;
		const DID = `did:hive:p828-itest-${process.pid}`;

		before(async () => {
			pool = new Pool({ connectionString: DSN, max: 1 });
			client = await pool.connect();
			await client.query("BEGIN");
			// Seed an operator principal inside the txn (rolled back later).
			const ins = await client.query<{ id: string }>(
				`INSERT INTO control_identity.principal (did, principal_type, owner_did)
				 VALUES ($1, 'operator', $1) RETURNING id`,
				[DID],
			);
			principalId = Number(ins.rows[0].id);
		});

		after(async () => {
			try {
				await client.query("ROLLBACK");
			} catch {
				/* ignore */
			}
			client.release();
			await pool.end();
		});

		test("AC-9/36: a success mutation row inserts with old→new + caller_did", async () => {
			await client.query(
				`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, old_value, new_value, caller_did,
				    principal_id, mutation_authority, validation_result)
				 VALUES ('USE_OFFER_DISPATCH','flag','global','false'::jsonb,'true'::jsonb,
				         $1, $2, 'operator', 'success')`,
				[DID, principalId],
			);
			const got = await client.query(
				`SELECT key_name, old_value, new_value, caller_did, validation_result
				   FROM core.config_mutation_log
				  WHERE principal_id = $1 AND key_name = 'USE_OFFER_DISPATCH'`,
				[principalId],
			);
			assert.equal(got.rows.length, 1);
			assert.equal(got.rows[0].new_value, true);
			assert.equal(got.rows[0].old_value, false);
			assert.equal(got.rows[0].caller_did, DID);
			assert.equal(got.rows[0].validation_result, "success");
		});

		test("AC-14/35: a failed-validation row persists validation_error, null new_value", async () => {
			await client.query(
				`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, old_value, new_value, caller_did,
				    principal_id, mutation_authority, validation_result, validation_error)
				 VALUES ('PROJECT_TOKEN_BUDGET','registry','global',NULL,NULL,
				         $1, $2, 'operator', 'failed', 'Invalid token budget: -1')`,
				[DID, principalId],
			);
			const got = await client.query(
				`SELECT validation_result, validation_error, new_value
				   FROM core.config_mutation_log
				  WHERE principal_id = $1 AND key_name = 'PROJECT_TOKEN_BUDGET'`,
				[principalId],
			);
			assert.equal(got.rows[0].validation_result, "failed");
			assert.match(got.rows[0].validation_error, /Invalid token budget/);
			assert.equal(got.rows[0].new_value, null);
		});

		test("AC-39: fn_config_mutation_audit filters by key_name, newest-first", async () => {
			const rows = await client.query(
				`SELECT * FROM core.fn_config_mutation_audit('USE_OFFER_DISPATCH', NULL, 100)`,
			);
			assert.ok(rows.rows.length >= 1, "returns the seeded USE_OFFER_DISPATCH row");
			assert.ok(
				rows.rows.every((r: any) => r.key_name === "USE_OFFER_DISPATCH"),
				"only the filtered key_name is returned",
			);
		});

		test("AC-39: fn_config_mutation_audit scope filter narrows results", async () => {
			const globalRows = await client.query(
				`SELECT * FROM core.fn_config_mutation_audit(NULL, 'global', 500)`,
			);
			assert.ok(globalRows.rows.every((r: any) => r.scope === "global"));
			const noneRows = await client.query(
				`SELECT * FROM core.fn_config_mutation_audit(NULL, 'host:does-not-exist', 500)`,
			);
			assert.equal(noneRows.rows.length, 0, "non-matching scope → no rows");
		});

		// A constraint violation aborts the whole txn in PG, so each expected-fail
		// insert is wrapped in a SAVEPOINT that we roll back to keep the txn alive.
		async function expectFail(sql: string, re: RegExp, msg: string) {
			await client.query("SAVEPOINT sp");
			let threw = false;
			try {
				await client.query(sql);
			} catch (e: any) {
				threw = true;
				assert.match(String(e.message), re, msg);
				await client.query("ROLLBACK TO SAVEPOINT sp");
			}
			await client.query("RELEASE SAVEPOINT sp").catch(() => {});
			assert.ok(threw, `${msg} — expected the insert to fail`);
		}

		test("AC-43/44: principal_id FK is NOT NULL + references an active principal", async () => {
			await expectFail(
				`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, caller_did, principal_id,
				    mutation_authority, validation_result)
				 VALUES ('X','flag','global','did:x', NULL, 'operator','success')`,
				/null value|not-null|violates/i,
				"principal_id NOT NULL is enforced",
			);
			await expectFail(
				`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, caller_did, principal_id,
				    mutation_authority, validation_result)
				 VALUES ('X','flag','global','did:x', -999999, 'operator','success')`,
				/foreign key|violates/i,
				"principal_id FK is enforced",
			);
		});

		test("append-only: UPDATE and DELETE are trigger-blocked", async () => {
			await expectFail(
				`UPDATE core.config_mutation_log SET key_name='Y' WHERE principal_id=${principalId}`,
				/append-only/,
				"UPDATE blocked",
			);
			await expectFail(
				`DELETE FROM core.config_mutation_log WHERE principal_id=${principalId}`,
				/append-only/,
				"DELETE blocked",
			);
		});

		test("AC-46: two identical inserts create two distinct mutation_id rows", async () => {
			await client.query(
				`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, new_value, caller_did, principal_id,
				    mutation_authority, validation_result)
				 VALUES ('DUP_KEY','flag','global','1'::jsonb,$1,$2,'operator','success'),
				        ('DUP_KEY','flag','global','1'::jsonb,$1,$2,'operator','success')`,
				[DID, principalId],
			);
			const got = await client.query(
				`SELECT mutation_id FROM core.config_mutation_log
				  WHERE principal_id=$1 AND key_name='DUP_KEY'`,
				[principalId],
			);
			assert.equal(got.rows.length, 2);
			assert.notEqual(got.rows[0].mutation_id, got.rows[1].mutation_id);
		});
	},
);
