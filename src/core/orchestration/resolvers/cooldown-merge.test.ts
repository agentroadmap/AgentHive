import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { Client } from "pg";
import { cooldownFilterSql } from "./route-policy-filters.ts";

/**
 * P1376 (P1365-D) AC-2/AC-3/AC-6: the resolver's Layer-6 cooldown filter must
 * merge the proactive (agency_capacity.reset_at) and reactive
 * (model_routes.cooldown_until) windows with GREATEST semantics — a route is
 * available only once BOTH windows have elapsed.
 *
 * Deterministic unit assertions on the generated SQL always run. The behavioral
 * tests seed agency_capacity inside a transaction that is ALWAYS rolled back
 * (no live-DB pollution) and are env-gated on a reachable Postgres.
 */

describe("cooldownFilterSql shape (P1376 AC-2)", () => {
	test("no agency param → reactive-only (backward compatible)", () => {
		const sql = cooldownFilterSql("mr");
		assert.match(sql, /mr\.cooldown_until/);
		assert.doesNotMatch(sql, /agency_capacity/);
	});

	test("with agency param → merges proactive agency_capacity.reset_at", () => {
		const sql = cooldownFilterSql("mr", 5);
		assert.match(sql, /mr\.cooldown_until/); // reactive retained
		assert.match(sql, /roadmap_workforce\.agency_capacity/); // proactive added
		assert.match(sql, /ac\.reset_at\s*>\s*NOW\(\)/);
		assert.match(sql, /\$5::text/); // bound to the agency param
	});
});

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";
let client: Client | null = null;

describe(
	"cooldown merge behavior (P1376 AC-3/AC-6, env-gated, tx-rolled-back)",
	{ skip: !DB_TEST },
	() => {
		const PROV = "p1376test_prov";
		const MODEL = "p1376test_model";
		const AGENCY = "p1376test_agency";

		before(async () => {
			client = new Client({
				host: process.env.PGHOST || "127.0.0.1",
				port: parseInt(process.env.PGPORT || "5432", 10),
				user: process.env.PGUSER || "admin",
				password: process.env.PGPASSWORD,
				database: process.env.PGDATABASE || "agenthive",
			});
			await client.connect();
			await client.query("BEGIN");
		});

		after(async () => {
			if (client) {
				await client.query("ROLLBACK"); // nothing persists
				await client.end();
			}
		});

		// A VALUES relation stands in for a model_routes candidate so we don't need
		// the model_metadata FK chain; the merged predicate only reads
		// route_provider / model_name / cooldown_until off the alias plus the real
		// agency_capacity table via the correlated subquery.
		// cooldownExpr is a raw SQL expression ("NULL" or "now() + interval '5 min'").
		const candidate = (cooldownExpr: string) =>
			`(VALUES (1::bigint, '${PROV}'::text, '${MODEL}'::text, (${cooldownExpr})::timestamptz)) AS mr(id, route_provider, model_name, cooldown_until)`;

		async function visible(cooldownExpr: string): Promise<boolean> {
			const sql = `SELECT mr.id FROM ${candidate(cooldownExpr)} WHERE ${cooldownFilterSql("mr", 1)}`;
			const { rows } = await client!.query(sql, [AGENCY]);
			return rows.length === 1;
		}

		// resetExpr is a raw SQL expression evaluated server-side ("now() + interval '5 min'").
		async function seedCapacity(resetExpr: string) {
			await client!.query(
				`INSERT INTO roadmap_workforce.agency_capacity
			   (provider, model, agency_id, reset_at, last_sampled_at, throttle_action, updated_at, p_skip)
			 VALUES ($1,$2,$3, (${resetExpr})::timestamptz, now(), 'none', now(), 0)`,
				[PROV, MODEL, AGENCY],
			);
		}

		test("AC-3a: neither window active → route visible", async () => {
			await client!.query("SAVEPOINT s");
			assert.equal(
				await visible("NULL"),
				true,
				"no cooldown + no capacity row should pass",
			);
			await client!.query("ROLLBACK TO SAVEPOINT s");
		});

		test("AC-3b: reactive-only future cooldown → route hidden", async () => {
			await client!.query("SAVEPOINT s");
			assert.equal(await visible("now() + interval '5 min'"), false);
			await client!.query("ROLLBACK TO SAVEPOINT s");
		});

		test("AC-3c: proactive-only future reset_at → route hidden (the bug this fixes)", async () => {
			await client!.query("SAVEPOINT s");
			await seedCapacity("now() + interval '5 min'");
			assert.equal(
				await visible("NULL"),
				false,
				"proactive reset_at must hide the route even with no reactive cooldown",
			);
			await client!.query("ROLLBACK TO SAVEPOINT s");
		});

		test("AC-3d: both windows elapsed → route visible", async () => {
			await client!.query("SAVEPOINT s");
			await seedCapacity("now() - interval '1 min'");
			assert.equal(await visible("now() - interval '1 min'"), true);
			await client!.query("ROLLBACK TO SAVEPOINT s");
		});

		test("AC-6: e2e GREATEST — short reactive (2m) does not unblock long proactive (5m)", async () => {
			await client!.query("SAVEPOINT s");
			await seedCapacity("now() + interval '5 min'"); // proactive hard throttle
			// reactive 429 backoff is shorter (2m) and already in the future, but the
			// proactive 5m window must still keep the route hidden.
			assert.equal(await visible("now() + interval '2 min'"), false);
			await client!.query("ROLLBACK TO SAVEPOINT s");
		});
	},
);
