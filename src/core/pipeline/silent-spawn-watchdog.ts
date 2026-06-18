/**
 * P3847 AC-3/4/5/6: Silent-spawn watchdog.
 *
 * Detects `agent_runs` rows that have been `running` for longer than
 * AGENTHIVE_SPAWN_NO_PROGRESS_MS (default 5 min) with zero tool calls logged
 * against their briefing — i.e. the worker process never started useful work.
 *
 * AC-4 safety: runs with tool_call_log activity (briefing_id IS NOT NULL and
 * at least one tool_call_log row after started_at) are never reaped.
 *
 * AC-5: calls incrementSpawnFailure() for the agency after marking timeout, so
 * P1360's throttle transitions fire after N consecutive silent failures.
 *
 * AC-6: writes/upserts a `silent_spawn_timeout` row into
 * roadmap.agency_observability_alert_state for Discord dedup alerting.
 */

import type { Pool } from "pg";
import type { ReaperLogger } from "./reap-stale-rows.ts";
import { incrementSpawnFailure } from "../orchestration/resolvers/agency-resolver.ts";

const SPAWN_NO_PROGRESS_MS = Number(
	process.env.AGENTHIVE_SPAWN_NO_PROGRESS_MS ?? 5 * 60 * 1_000,
);

export interface SilentWatchdogResult {
	silentSpawnsTimedOut: number;
}

interface SilentRunRow {
	id: string;
	agency_identity: string | null;
	proposal_id: string | null;
}

export async function detectAndReapSilentSpawns(
	pool: Pool,
	logger: ReaperLogger,
	tag = "SilentWatchdog",
): Promise<SilentWatchdogResult> {
	const thresholdMs = SPAWN_NO_PROGRESS_MS;
	const thresholdInterval = `${thresholdMs} milliseconds`;

	// Find running rows past threshold with no tool calls on their briefing.
	// A NULL briefing_id means legacy spawns without tracking — also silent.
	// Note: agent_runs has no dispatch_id FK; squad_dispatch orphans are handled
	// by the existing 20-min squad_dispatch reaper in reap-stale-rows.ts.
	let silentRows: SilentRunRow[] = [];
	try {
		const { rows } = await pool.query<SilentRunRow>(
			`SELECT ar.id,
			        ar.agency_identity,
			        ar.proposal_id::text
			   FROM roadmap_workforce.agent_runs ar
			  WHERE ar.status = 'running'
			    AND ar.started_at < now() - ($1)::interval
			    AND (
			          ar.briefing_id IS NULL
			          OR NOT EXISTS (
			            SELECT 1
			              FROM roadmap.tool_call_log tcl
			             WHERE tcl.briefing_id = ar.briefing_id
			               AND tcl.created_at > ar.started_at
			          )
			        )`,
			[thresholdInterval],
		);
		silentRows = rows;
	} catch (err) {
		logger.warn(
			`[${tag}] silent-run scan failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { silentSpawnsTimedOut: 0 };
	}

	if (silentRows.length === 0) {
		return { silentSpawnsTimedOut: 0 };
	}

	let reaped = 0;
	for (const row of silentRows) {
		try {
			// Mark the agent_run as timeout
			await pool.query(
				`UPDATE roadmap_workforce.agent_runs
				 SET status = 'timeout',
				     completed_at = now(),
				     error_detail = 'P3847: silent spawn — no tool calls within threshold; reaped by watchdog'
				 WHERE id = $1 AND status = 'running'`,
				[row.id],
			);

			// AC-5: throttle counter so P1360 can gate repeated silent agencies
			if (row.agency_identity) {
				await incrementSpawnFailure(row.agency_identity, 3, "timeout");
			}

			// AC-6: upsert observability alert for Discord dedup
			if (row.agency_identity) {
				await pool.query(
					`INSERT INTO roadmap.agency_observability_alert_state
					   (alert_key, agency_id, alert_type, last_fired_at, metadata)
					 VALUES ($1, $2, 'silent_spawn_timeout', now(), $3::jsonb)
					 ON CONFLICT (alert_key) DO UPDATE
					   SET last_fired_at = CASE
					       WHEN roadmap.agency_observability_alert_state.last_fired_at
					            < now() - interval '10 minutes'
					       THEN now()
					       ELSE roadmap.agency_observability_alert_state.last_fired_at
					     END,
					     cleared_at = NULL,
					     metadata = EXCLUDED.metadata`,
					[
						`silent_spawn_timeout:${row.agency_identity}`,
						row.agency_identity,
						JSON.stringify({
							agent_run_id: row.id,
							proposal_id: row.proposal_id,
							threshold_ms: thresholdMs,
						}),
					],
				);
			}

			reaped++;
		} catch (err) {
			logger.warn(
				`[${tag}] failed to reap silent run ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return { silentSpawnsTimedOut: reaped };
}
