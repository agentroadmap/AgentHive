/**
 * P3847 Part B (AC-3 / AC-4) — live-DB integration test for the silent-spawn
 * no-progress watchdog.
 *
 * ENV-GATED and run entirely inside a transaction that is ALWAYS rolled back, so
 * it seeds + reaps real rows without leaving any permanent data:
 *
 *   AGENTHIVE_WATCHDOG_DB_TEST=1 \
 *   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=admin PGPASSWORD=… PGDATABASE=agenthive \
 *   node --import jiti/register --test \
 *     src/core/pipeline/no-progress-watchdog.integration.test.ts
 *
 * Covered ACs:
 *   AC-3  a status='running' agent_run that is silent (no tool-call activity AND
 *         only the bare `persona=<x>` output) past the no-progress threshold is
 *         reaped to status='timeout' with a 'no-progress' error_detail.
 *   AC-4  a run that IS progressing — via tool-call activity OR real output — is
 *         NOT reaped even though it is equally old (progress gate, not elapsed).
 *
 * Assertions target the specific seeded run ids, so other live 'running' rows in
 * the shared DB do not affect the result (any they touch is rolled back anyway).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { reapSilentNoProgressRuns } from "./no-progress-watchdog.ts";

const DB_TEST = process.env.AGENTHIVE_WATCHDOG_DB_TEST === "1";
const silentLogger = { warn: () => {}, log: () => {} };

/**
 * Type-safe membership: agent_runs.id is bigint, which node-pg returns as a
 * STRING, while our seeded ids are numbers — compare as strings.
 */
function reaped(
	result: { reapedRunIds: Array<number | string> },
	id: number,
): boolean {
	return result.reapedRunIds.map(String).includes(String(id));
}

interface SeededRun {
	id: number;
	briefingId: string;
}

async function withRollback(
	fn: (client: import("pg").Client, suffix: string) => Promise<void>,
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
	const suffix = `wdtest_${process.pid}_${Date.now()}`;
	try {
		await client.query("BEGIN");
		await fn(client, suffix);
	} finally {
		await client.query("ROLLBACK").catch(() => {});
		await client.end();
	}
}

/**
 * Seed a status='running' agent_run started `ageMin` minutes ago.
 * - `output` sets output_summary (bare `persona=x ` = silent; anything else = real).
 * - `toolCalls` > 0 seeds a spawn_tool_call_counter row (= progressing).
 */
async function seedRun(
	client: import("pg").Client,
	suffix: string,
	opts: {
		ageMin: number;
		output: string;
		toolCalls: number;
		tag: string;
		proposalId?: number;
		agency?: string;
	},
): Promise<SeededRun> {
	const briefingId = randomUUID();
	const agencyIdentity = opts.agency ?? `wd-agency-${suffix}`;
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO roadmap_workforce.agent_runs
		   (agent_identity, stage, model_used, status, started_at,
		    output_summary, briefing_id, agency_identity, proposal_id)
		 VALUES ($1, 'DEVELOP', 'test-model', 'running',
		         now() - ($2 || ' minutes')::interval,
		         $3, $4::uuid, $5, $6)
		 RETURNING id`,
		[
			`worker-${opts.tag}-${suffix}`,
			String(opts.ageMin),
			opts.output,
			briefingId,
			agencyIdentity,
			opts.proposalId ?? null,
		],
	);
	if (opts.toolCalls > 0) {
		// spawn_tool_call_counter.briefing_id FKs to spawn_briefing_config.
		await client.query(
			`INSERT INTO roadmap.spawn_briefing_config (briefing_id) VALUES ($1::uuid)`,
			[briefingId],
		);
		await client.query(
			`INSERT INTO roadmap.spawn_tool_call_counter
			   (briefing_id, total_tool_calls_made, updated_at)
			 VALUES ($1::uuid, $2, now())`,
			[briefingId, opts.toolCalls],
		);
	}
	return { id: Number(rows[0].id), briefingId };
}

async function statusOf(client: import("pg").Client, id: number): Promise<string> {
	const { rows } = await client.query<{ status: string }>(
		`SELECT status FROM roadmap_workforce.agent_runs WHERE id = $1`,
		[id],
	);
	return rows[0]?.status ?? "(missing)";
}

describe("P3847 no-progress watchdog live integration", { skip: !DB_TEST }, () => {
	test("AC-3: a silent, old running run is reaped to 'timeout' with a no-progress error_detail", async () => {
		await withRollback(async (client, suffix) => {
			// 10 min old, bare persona output, no tool-call counter → silent.
			const silent = await seedRun(client, suffix, {
				ageMin: 10,
				output: "persona=wdtest ",
				toolCalls: 0,
				tag: "silent",
			});

			const result = await reapSilentNoProgressRuns(
				client as unknown as Pool,
				silentLogger,
				{ noProgressMs: 300_000, tag: `wd-${suffix}` },
			);

			assert.ok(
				reaped(result, silent.id),
				`silent run ${silent.id} should be reaped (got ${result.reapedRunIds.join(",")})`,
			);
			assert.equal(await statusOf(client, silent.id), "timeout");

			const { rows } = await client.query<{ error_detail: string }>(
				`SELECT error_detail FROM roadmap_workforce.agent_runs WHERE id = $1`,
				[silent.id],
			);
			assert.match(rows[0].error_detail, /no-progress: silent for/);
		});
	});

	test("AC-4: progressing runs (tool-calls OR real output) are NOT reaped even when equally old", async () => {
		await withRollback(async (client, suffix) => {
			const silent = await seedRun(client, suffix, {
				ageMin: 10,
				output: "persona=wdtest ",
				toolCalls: 0,
				tag: "silent",
			});
			// Same age, but making tool calls → progressing.
			const progByTools = await seedRun(client, suffix, {
				ageMin: 10,
				output: "persona=wdtest ",
				toolCalls: 5,
				tag: "tools",
			});
			// Same age, but emitting real output → progressing.
			const progByOutput = await seedRun(client, suffix, {
				ageMin: 10,
				output: "persona=wdtest produced a real plan and edited files",
				toolCalls: 0,
				tag: "output",
			});

			const result = await reapSilentNoProgressRuns(
				client as unknown as Pool,
				silentLogger,
				{ noProgressMs: 300_000, tag: `wd-${suffix}` },
			);

			assert.ok(
				reaped(result, silent.id),
				"the silent control run should still be reaped",
			);
			assert.ok(
				!reaped(result, progByTools.id),
				"a run making tool calls must NOT be reaped",
			);
			assert.ok(
				!reaped(result, progByOutput.id),
				"a run emitting real output must NOT be reaped",
			);
			assert.equal(await statusOf(client, progByTools.id), "running");
			assert.equal(await statusOf(client, progByOutput.id), "running");
		});
	});

	test("AC-4 (boundary): a young silent run (under the threshold) is NOT reaped", async () => {
		await withRollback(async (client, suffix) => {
			// 1 min old, silent — but under the 5-min no-progress threshold.
			const young = await seedRun(client, suffix, {
				ageMin: 1,
				output: "persona=wdtest ",
				toolCalls: 0,
				tag: "young",
			});

			const result = await reapSilentNoProgressRuns(
				client as unknown as Pool,
				silentLogger,
				{ noProgressMs: 300_000, tag: `wd-${suffix}` },
			);

			assert.ok(
				!reaped(result, young.id),
				"a run younger than the no-progress threshold must NOT be reaped",
			);
			assert.equal(await statusOf(client, young.id), "running");
		});
	});

	test("V3-C2: a reaped run's live offer is stamped lease_expired/transient (NOT unknown — no breaker poison / stake slash)", async () => {
		await withRollback(async (client, suffix) => {
			// Use a real proposal id (agent_runs.proposal_id may FK to proposal).
			const { rows: pr } = await client.query<{ id: string }>(
				`SELECT id FROM roadmap_proposal.proposal ORDER BY id DESC LIMIT 1`,
			);
			const proposalId = Number(pr[0].id);
			// squad_dispatch.agency_identity FKs to agent_registry → use a real one.
			const { rows: ag } = await client.query<{ agent_identity: string }>(
				`SELECT agent_identity FROM roadmap_workforce.agent_registry
				  WHERE agent_identity = 'claude-bot-gary.a' LIMIT 1`,
			);
			const agency = ag[0]?.agent_identity ?? "claude-bot-gary.a";

			const silent = await seedRun(client, suffix, {
				ageMin: 10,
				output: "persona=wdtest ",
				toolCalls: 0,
				tag: "silent",
				proposalId,
				agency,
			});
			// A live, unclassified offer for the same proposal+agency. Satisfy the
			// squad_dispatch CHECKs: claimed ⇒ worker_identity NOT NULL,
			// required_capabilities non-empty array, project_id NOT NULL.
			const { rows: od } = await client.query<{ id: string }>(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, agency_identity,
				    dispatch_status, offer_status, worker_identity,
				    required_capabilities, project_id)
				 VALUES ($1, $2, 'developer', $3,
				         'claimed', 'claimed', $4,
				         '["text_generation"]'::jsonb,
				         (SELECT COALESCE(project_id, 1) FROM roadmap_proposal.proposal WHERE id = $1))
				 RETURNING id`,
				[proposalId, `wd-offer-${suffix}`, agency, agency],
			);
			const offerId = Number(od[0].id);

			await reapSilentNoProgressRuns(client as unknown as Pool, silentLogger, {
				noProgressMs: 300_000,
				tag: `wd-${suffix}`,
			});

			assert.equal(
				await statusOf(client, silent.id),
				"timeout",
				"the silent run should have been reaped",
			);

			const { rows } = await client.query<{
				failure_class: string | null;
				failure_is_transient: boolean | null;
			}>(
				`SELECT failure_class, failure_is_transient
				   FROM roadmap_workforce.squad_dispatch WHERE id = $1`,
				[offerId],
			);
			assert.equal(
				rows[0].failure_class,
				"lease_expired",
				"the reaped offer must be stamped lease_expired (transient), not unknown",
			);
			assert.equal(rows[0].failure_is_transient, true);
		});
	});
});
