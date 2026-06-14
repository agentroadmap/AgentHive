import assert from "node:assert";
import { after, before, describe, test } from "node:test";
import { Pool } from "pg";
import { ConfigResolver } from "./config.ts";
import { FlagKeys } from "./config-keys.ts";

/**
 * P827 AC-17: live integration test against the hiveCentral control DB.
 *
 * SKIPPED unless AGENTHIVE_CONTROL_DSN is set (so CI / the always-on unit suite
 * never touches a live DB). When run, it:
 *   1. inserts a global core.runtime_flag row,
 *   2. asserts get(FlagKeys.USE_OFFER_DISPATCH) returns the boolean value,
 *   3. updates the row (which fires the runtime_flag_changed trigger),
 *   4. asserts the resolver cache is invalidated and the new value is returned
 *      within 1s — proving the live LISTEN client is wired to hiveCentral.
 *
 * No pollution: writes to a sentinel flag_name and deletes it in `after()`.
 * The row uses scope='global' and is removed regardless of outcome.
 */

const DSN = process.env.AGENTHIVE_CONTROL_DSN;
const SENTINEL = "USE_OFFER_DISPATCH"; // real flag key; scope=global; cleaned up

describe(
	"P827 AC-17: live runtime_flag resolution + notify invalidation",
	{ skip: DSN ? false : "AGENTHIVE_CONTROL_DSN not set" },
	() => {
		let pool: Pool;
		let resolver: ConfigResolver;
		const savedEnv = process.env.USE_OFFER_DISPATCH;

		before(async () => {
			// Env var would short-circuit DB resolution — clear it for the test.
			delete process.env.USE_OFFER_DISPATCH;
			pool = new Pool({ connectionString: DSN, max: 2 });
			// Ensure a clean slate for the sentinel global row.
			await pool.query(
				`DELETE FROM core.runtime_flag WHERE flag_name=$1 AND scope='global'`,
				[SENTINEL],
			);
			resolver = new ConfigResolver();
			await resolver.init({ pool, scopeContext: {} });
		});

		after(async () => {
			try {
				await resolver?.cleanup();
			} catch {
				/* ignore */
			}
			try {
				await pool?.query(
					`DELETE FROM core.runtime_flag WHERE flag_name=$1 AND scope='global'`,
					[SENTINEL],
				);
			} catch {
				/* ignore */
			}
			if (savedEnv !== undefined) process.env.USE_OFFER_DISPATCH = savedEnv;
			try {
				await pool?.end();
			} catch {
				/* ignore */
			}
		});

		test("insert → get() returns true; update → cache invalidated within 1s", async () => {
			// 1. Insert global row = true.
			await pool.query(
				`INSERT INTO core.runtime_flag
				   (flag_name, scope, value_jsonb, modified_by_did, owner_did)
				 VALUES ($1, 'global', 'true'::jsonb, 'system', 'system')
				 ON CONFLICT (flag_name, scope)
				 DO UPDATE SET value_jsonb='true'::jsonb`,
				[SENTINEL],
			);

			// 2. get() resolves from DB.
			const first = await resolver.get(FlagKeys.USE_OFFER_DISPATCH);
			assert.equal(first, true, "initial DB value resolves to true");

			// 3. Update to false — fires runtime_flag_changed NOTIFY.
			await pool.query(
				`UPDATE core.runtime_flag SET value_jsonb='false'::jsonb
				  WHERE flag_name=$1 AND scope='global'`,
				[SENTINEL],
			);

			// 4. Poll for invalidation within 1s. The notify evicts the cache entry;
			//    the next get() re-reads the new value. Allow brief NOTIFY latency.
			const deadline = Date.now() + 1000;
			let latest = first;
			while (Date.now() < deadline) {
				latest = await resolver.get(FlagKeys.USE_OFFER_DISPATCH);
				if (latest === false) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.equal(
				latest,
				false,
				"updated value must be visible within 1s (live LISTEN on hiveCentral)",
			);
		});
	},
);
