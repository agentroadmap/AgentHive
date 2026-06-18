import assert from "node:assert";
import { describe, test } from "node:test";
import { reapSilentNoProgressRuns } from "../../../src/core/pipeline/no-progress-watchdog.ts";

/**
 * P3847 Part B — silent no-progress watchdog (AC-3..6).
 *
 * Live-DB tests inside ROLLBACK transactions (nothing persisted). The watchdog
 * accepts the transaction client, so the reap + lease release + throttle + alert
 * are all observable and rolled back together.
 *
 *   AC-3: a silent running run (no tool-calls, bare output) past the threshold is
 *         reaped to status='timeout' with a 'no-progress: silent for Ns' detail,
 *         and its lease is released; a progressing run is NOT reaped.
 *   AC-4: no false kills — tool-call activity / real output / too-recent runs are
 *         left alone (the gate is the progress signal, not elapsed time).
 *   AC-5: the P1360 throttle is bumped on each silent timeout (→ 'throttled' at
 *         the threshold), so a repeatedly-silent route is backed off.
 *   AC-6: a silent-spawn observability alert row is written.
 *
 * Run:
 *   AGENTHIVE_RESOLVER_DB_TEST=1 PGDATABASE=agenthive \
 *     node --import jiti/register --test \
 *     scripts/migrations/__tests__/p3847-no-progress-watchdog.test.ts
 */

const DB_TEST = process.env.AGENTHIVE_RESOLVER_DB_TEST === "1";
const NO_PROGRESS_MS = 300_000; // 5 min threshold used by the tests
const SILENT_AGO = "6 minutes"; // past the threshold
const RECENT_AGO = "1 minute"; // under the threshold

const silentLogger = { warn: () => {}, log: () => {} };

async function withRollback(fn: (client: import("pg").Client) => Promise<void>) {
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
		await fn(client);
	} finally {
		await client.query("ROLLBACK").catch(() => {});
		await client.end();
	}
}

async function seedAgency(
	client: import("pg").Client,
	identity: string,
	throttleCount = 0,
): Promise<void> {
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type)
		 VALUES ($1, 'llm')
		 ON CONFLICT (agent_identity) DO UPDATE SET agent_type = 'llm'
		 RETURNING id`,
		[identity],
	);
	await client.query(
		`INSERT INTO roadmap_workforce.provider_registry
		   (agency_id, agency_identity, status, throttle_count, recent_failure_count)
		 VALUES ($1, $2, 'active', $3, 0)`,
		[rows[0].id, identity, throttleCount],
	);
}

async function seedProposalWithLease(
	client: import("pg").Client,
	agency: string,
): Promise<number> {
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_proposal.proposal (title, type, status, maturity, priority, audit)
		 VALUES ('p3847-test', 'feature', 'DEVELOP', 'active', 'high', '{}'::jsonb)
		 RETURNING id`,
	);
	const pid = rows[0].id;
	await client.query(
		`INSERT INTO roadmap_proposal.proposal_lease
		   (proposal_id, agent_identity, expires_at, released_at)
		 VALUES ($1, $2, now() + interval '30 minutes', NULL)`,
		[pid, agency],
	);
	return pid;
}

async function seedRun(
	client: import("pg").Client,
	opts: {
		agency: string;
		proposalId: number | null;
		startedAgo: string;
		output: string | null;
		briefingId?: string | null;
	},
): Promise<number> {
	const { rows } = await client.query<{ id: number }>(
		`INSERT INTO roadmap_workforce.agent_runs
		   (agent_identity, agency_identity, proposal_id, stage, model_used, status,
		    started_at, output_summary, briefing_id)
		 VALUES ($1, $1, $2, 'develop', 'claude-opus-4-8', 'running',
		         now() - ($3)::interval, $4, $5)
		 RETURNING id`,
		[opts.agency, opts.proposalId, opts.startedAgo, opts.output, opts.briefingId ?? null],
	);
	return rows[0].id;
}

describe("P3847 Part B: silent no-progress watchdog (DB)", { skip: !DB_TEST }, () => {
	test("AC-3: a silent run past the threshold is reaped (timeout + lease released)", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-silent";
			await seedAgency(client, agency);
			const pid = await seedProposalWithLease(client, agency);
			const runId = await seedRun(client, {
				agency,
				proposalId: pid,
				startedAgo: SILENT_AGO,
				output: "persona=architect ", // bare silent signature
			});

			const res = await reapSilentNoProgressRuns(client, silentLogger, {
				noProgressMs: NO_PROGRESS_MS,
			});

			assert.equal(res.silentRunsReaped, 1, "the silent run must be reaped");
			assert.ok(res.reapedRunIds.includes(runId));
			const { rows } = await client.query<{ status: string; error_detail: string }>(
				`SELECT status, error_detail FROM roadmap_workforce.agent_runs WHERE id = $1`,
				[runId],
			);
			assert.equal(rows[0].status, "timeout");
			assert.match(rows[0].error_detail, /no-progress: silent for \d+s/);
			const { rows: lease } = await client.query<{ released_at: string | null; release_reason: string }>(
				`SELECT released_at, release_reason FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1`,
				[pid],
			);
			assert.ok(lease[0].released_at !== null, "AC-3: lease must be released");
			assert.equal(lease[0].release_reason, "work_failed");
		});
	});

	test("AC-4: a run with tool-call activity is NOT reaped", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-active-calls";
			await seedAgency(client, agency);
			const briefing = "11111111-1111-1111-1111-111111111111";
			const runId = await seedRun(client, {
				agency,
				proposalId: null,
				startedAgo: SILENT_AGO,
				output: "persona=architect ",
				briefingId: briefing,
			});
			await client.query(
				`INSERT INTO roadmap.spawn_briefing_config (briefing_id) VALUES ($1)
				 ON CONFLICT (briefing_id) DO NOTHING`,
				[briefing],
			);
			await client.query(
				`INSERT INTO roadmap.spawn_tool_call_counter
				   (briefing_id, total_tool_calls_made, calls_since_last_checkpoint, updated_at)
				 VALUES ($1, 7, 7, now())`,
				[briefing],
			);
			const res = await reapSilentNoProgressRuns(client, silentLogger, { noProgressMs: NO_PROGRESS_MS });
			assert.equal(res.silentRunsReaped, 0, "a run that made tool calls must not be reaped");
			const { rows } = await client.query<{ status: string }>(
				`SELECT status FROM roadmap_workforce.agent_runs WHERE id = $1`,
				[runId],
			);
			assert.equal(rows[0].status, "running");
		});
	});

	test("AC-4: a run with real output is NOT reaped", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-real-output";
			await seedAgency(client, agency);
			const runId = await seedRun(client, {
				agency,
				proposalId: null,
				startedAgo: SILENT_AGO,
				output: "persona=architect — wrote module X, 3 tests passing",
			});
			const res = await reapSilentNoProgressRuns(client, silentLogger, { noProgressMs: NO_PROGRESS_MS });
			assert.equal(res.silentRunsReaped, 0, "a run with real output must not be reaped");
		});
	});

	test("AC-4: a too-recent run (under threshold) is NOT reaped", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-recent";
			await seedAgency(client, agency);
			const runId = await seedRun(client, {
				agency,
				proposalId: null,
				startedAgo: RECENT_AGO,
				output: "persona=architect ",
			});
			const res = await reapSilentNoProgressRuns(client, silentLogger, { noProgressMs: NO_PROGRESS_MS });
			assert.equal(res.silentRunsReaped, 0, "a run under the threshold must not be reaped");
			void runId;
		});
	});

	test("AC-5: the P1360 throttle is bumped and trips to 'throttled' at the threshold", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-throttle";
			await seedAgency(client, agency, 2); // one below THROTTLE_THRESHOLD (3)
			await seedRun(client, {
				agency,
				proposalId: null,
				startedAgo: SILENT_AGO,
				output: "persona=architect ",
			});
			await reapSilentNoProgressRuns(client, silentLogger, { noProgressMs: NO_PROGRESS_MS });
			const { rows } = await client.query<{ throttle_count: number; status: string }>(
				`SELECT throttle_count, status FROM roadmap_workforce.provider_registry WHERE agency_identity = $1`,
				[agency],
			);
			assert.equal(rows[0].throttle_count, 3, "throttle_count must increment on a silent timeout");
			assert.equal(rows[0].status, "throttled", "AC-5: agency backs off (throttled) at the threshold");
		});
	});

	test("AC-6: a silent-spawn observability alert row is written", async () => {
		await withRollback(async (client) => {
			const agency = "p3847-alert";
			await seedAgency(client, agency);
			await seedRun(client, {
				agency,
				proposalId: null,
				startedAgo: SILENT_AGO,
				output: "persona=architect ",
			});
			await reapSilentNoProgressRuns(client, silentLogger, { noProgressMs: NO_PROGRESS_MS });
			const { rows } = await client.query<{ alert_type: string; cleared_at: string | null }>(
				`SELECT alert_type, cleared_at FROM roadmap.agency_observability_alert_state
				  WHERE agency_id = $1 AND alert_type = 'silent_spawn'`,
				[agency],
			);
			assert.equal(rows.length, 1, "AC-6: a silent_spawn alert-state row must be written");
			assert.equal(rows[0].cleared_at, null, "the alert must be active (not cleared)");
		});
	});
});
