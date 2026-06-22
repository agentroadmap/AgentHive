/**
 * P4626 AC-3 / AC-10 / AC-11 — Final-schema invariant tests.
 *
 * After all migrations are applied, the DEPLOYED definition of governance-
 * critical database functions must hold specific invariants. We assert these by
 * reading `pg_get_functiondef()` from the catalog — i.e. we check what is
 * ACTUALLY deployed, not what some migration file says.
 *
 * This is the regression guard for the semantic-writer hazard (P4626 Gate 4):
 * `roadmap_proposal.fn_guard_gate_advance` was rewritten across 6 migrations
 * (040/174/189/270/289/299). The 2026 P906 incident was exactly a later rewrite
 * silently dropping a prior governance invariant (the gate-bypass removal). A
 * file-grep gate cannot catch that — only asserting the final, merged catalog
 * definition can. These tests are that assertion.
 *
 * SAFETY: READ-ONLY. We only call pg_get_functiondef / catalog lookups; we never
 * mutate. The suite is SKIPPED unless AGENTHIVE_ALLOW_LIVE_DB=1 so it does not
 * hit a DB in environments that don't have one. Connection params come from
 * PGHOST/PGPORT/PGUSER/PGDATABASE (default local docker postgres-db on 5432).
 *
 * Run: AGENTHIVE_ALLOW_LIVE_DB=1 PGPORT=5432 \
 *      node --import jiti/register --test tests/integration/final-schema-invariants.test.ts
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

let client: Client | null = null;

async function functionDef(
	schema: string,
	name: string,
): Promise<string | null> {
	if (!client) throw new Error("client not initialised");
	const res = await client.query<{ def: string }>(
		`SELECT pg_get_functiondef(p.oid) AS def
		   FROM pg_proc p
		   JOIN pg_namespace n ON n.oid = p.pronamespace
		  WHERE p.proname = $1 AND n.nspname = $2
		  LIMIT 1`,
		[name, schema],
	);
	return res.rows[0]?.def ?? null;
}

describe(
	"P4626 final-schema invariants (deployed catalog)",
	{ skip: !LIVE },
	() => {
		before(async () => {
			client = new Client({
				host: process.env.PGHOST ?? "127.0.0.1",
				port: Number(process.env.PGPORT ?? "5432"),
				user: process.env.PGUSER ?? "admin",
				database: process.env.PGDATABASE ?? "agenthive",
				// READ-ONLY session: belt-and-suspenders against accidental writes.
				application_name: "p4626-final-schema-invariants",
			});
			await client.connect();
			await client.query("SET default_transaction_read_only = on");
		});

		after(async () => {
			if (client) await client.end();
			client = null;
		});

		it("fn_guard_gate_advance is deployed exactly once (single live definer)", async () => {
			const res = await client!.query<{ n: string }>(
				`SELECT count(*)::text AS n
			   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			  WHERE p.proname = 'fn_guard_gate_advance' AND n.nspname = 'roadmap_proposal'`,
			);
			assert.equal(
				res.rows[0]?.n,
				"1",
				"exactly one roadmap_proposal.fn_guard_gate_advance must be deployed",
			);
		});

		it("fn_guard_gate_advance INVARIANT: never consults app.gate_bypass (P906/P3929 restoration)", async () => {
			const def = await functionDef(
				"roadmap_proposal",
				"fn_guard_gate_advance",
			);
			assert.ok(def, "fn_guard_gate_advance must exist in the deployed schema");
			// The regression we guard against: a rewrite re-introducing a runtime
			// bypass read. Any active `current_setting('app.gate_bypass'...)` that is
			// not inside a comment is the forbidden pattern.
			const codeOnly = def!
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/--[^\n]*/g, " ");
			assert.ok(
				!/current_setting\(\s*'app\.gate_bypass'/i.test(codeOnly),
				"deployed fn_guard_gate_advance must NOT read app.gate_bypass — the P906 bypass regression",
			);
		});

		it("fn_guard_gate_advance INVARIANT: enforces the 48h governance deliberation window", async () => {
			const def = await functionDef(
				"roadmap_proposal",
				"fn_guard_gate_advance",
			);
			assert.ok(def);
			assert.match(
				def!,
				/INTERVAL\s+'48 hours'/i,
				"deployed guard must enforce the P181/Art.VII§19 48-hour governance deliberation window",
			);
			assert.match(
				def!,
				/governance-amendment/i,
				"deployed guard must special-case governance-amendment proposals",
			);
		});

		it("fn_guard_gate_advance INVARIANT: consults gate_decision_log (decision must exist)", async () => {
			const def = await functionDef(
				"roadmap_proposal",
				"fn_guard_gate_advance",
			);
			assert.ok(def);
			assert.match(
				def!,
				/gate_decision_log/i,
				"deployed guard must verify a gate_decision_log row exists before allowing advance",
			);
		});

		it("fn_apply_gate_advance is deployed exactly once (companion guard, 6 historical definers)", async () => {
			const res = await client!.query<{ n: string }>(
				`SELECT count(*)::text AS n
			   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			  WHERE p.proname = 'fn_apply_gate_advance' AND n.nspname = 'roadmap_proposal'`,
			);
			assert.equal(res.rows[0]?.n, "1");
		});
	},
);
