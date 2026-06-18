/**
 * P3847 Part B — silent-spawn no-progress watchdog.
 *
 * The P467/P475 stuck-detection only observes a subagent that IS making tool
 * calls (N-strikes / checkpoints). A subagent that hangs producing ZERO output
 * (auth hang, model-no-response, startup wedge) emits nothing and evades every
 * strike rule, dying only at the ~20-min hard spawn timeout — 582 of 639 failed
 * runs in a week were exactly this: ~20 min wall, empty error_detail, bare
 * `persona=<x>` output and nothing after.
 *
 * This watchdog runs on the orchestrator reaper interval and reaps a
 * status='running' agent_run that has shown NO progress (no tool-call/checkpoint
 * activity AND no real output) for AGENTHIVE_SPAWN_NO_PROGRESS_MS — well before
 * the hard zombie timeout. It marks the run timeout with a diagnostic
 * error_detail, releases the lease, applies the P1360 spawn-failure throttle so
 * a repeatedly-silent route is backed off rather than tight-loop re-dispatched,
 * and raises a silent-spawn observability alert.
 *
 * It gates on a PROGRESS SIGNAL, never on elapsed time alone (AC-4): a long-
 * running spawn that is emitting tool-calls or real output is never reaped here;
 * those that genuinely run past the hard threshold are left to the zombie reaper.
 */
import type { Pool, PoolClient } from "pg";

/** Default: 5 min — comfortably under the ~20-min hard spawn timeout. */
export const DEFAULT_SPAWN_NO_PROGRESS_MS = 300_000;

/** Keep in sync with reap-stale-rows.ts AGENT_RUN_ZOMBIE_MIN (the hard floor). */
const AGENT_RUN_ZOMBIE_SEC = 60 * 60;

/** Mirrors resolvers/agency-resolver.ts THROTTLE_THRESHOLD (P1360). */
const DEFAULT_THROTTLE_THRESHOLD = 3;

export interface NoProgressWatchdogResult {
	silentRunsReaped: number;
	reapedRunIds: number[];
}

interface WatchdogLogger {
	warn: (message: string) => void;
	log?: (message: string) => void;
}

interface ReapedRow {
	id: number;
	proposal_id: number | null;
	agency_identity: string | null;
	silent_for_s: number;
}

function resolveNoProgressMs(explicit?: number): number {
	const envVal = Number(process.env.AGENTHIVE_SPAWN_NO_PROGRESS_MS);
	const chosen =
		explicit ??
		(Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_SPAWN_NO_PROGRESS_MS);
	// Never let the watchdog fire on sub-30s runs (startup is legitimately quiet).
	return Math.max(30_000, chosen);
}

/**
 * Reap status='running' agent_runs that have been silent (no progress signal)
 * for longer than the no-progress threshold but not yet past the hard zombie
 * threshold. Single-connection: pass a Pool in production or a transaction
 * PoolClient in tests so the whole effect is observable/rollback-able together.
 */
export async function reapSilentNoProgressRuns(
	db: Pool | PoolClient,
	logger: WatchdogLogger,
	opts?: { noProgressMs?: number; throttleThreshold?: number; tag?: string },
): Promise<NoProgressWatchdogResult> {
	const tag = opts?.tag ?? "NoProgressWatchdog";
	const noProgressSec = Math.round(resolveNoProgressMs(opts?.noProgressMs) / 1000);
	const throttleThreshold = opts?.throttleThreshold ?? DEFAULT_THROTTLE_THRESHOLD;
	const result: NoProgressWatchdogResult = { silentRunsReaped: 0, reapedRunIds: [] };

	let reaped: ReapedRow[];
	try {
		const r = await db.query<ReapedRow>(
			`UPDATE roadmap_workforce.agent_runs ar
			 SET status = 'timeout',
			     completed_at = now(),
			     error_detail = 'no-progress: silent for '
			       || floor(extract(epoch FROM (now() - ar.started_at)))::int || 's '
			       || '(no tool-call/checkpoint/output for >' || $1
			       || 's; reaped by the no-progress watchdog before the hard spawn timeout)'
			 WHERE ar.status = 'running'
			   -- Past the no-progress threshold ...
			   AND ar.started_at < now() - ($1 || ' seconds')::interval
			   -- ... but not yet at the hard zombie threshold (older rows are the zombie reaper's).
			   AND ar.started_at >= now() - ($2 || ' seconds')::interval
			   -- PROGRESS GATE (AC-4): no tool-call/checkpoint activity at all.
			   AND NOT EXISTS (
			     SELECT 1 FROM roadmap.spawn_tool_call_counter tc
			     WHERE tc.briefing_id = ar.briefing_id
			       AND (tc.total_tool_calls_made > 0
			            OR tc.updated_at > now() - ($1 || ' seconds')::interval)
			   )
			   -- ... and no REAL output — only the bare 'persona=<x>' silent signature.
			   -- POSIX classes ([[:space:]]) avoid backslash-escape pitfalls.
			   AND length(regexp_replace(COALESCE(ar.output_summary, ''),
			                             '^[[:space:]]*persona=[^[:space:]]+[[:space:]]*$', '', 'i')) = 0
			 RETURNING id, proposal_id, agency_identity,
			           floor(extract(epoch FROM (now() - started_at)))::int AS silent_for_s`,
			[String(noProgressSec), String(AGENT_RUN_ZOMBIE_SEC)],
		);
		reaped = r.rows;
	} catch (err) {
		logger.warn(
			`[${tag}] silent no-progress reap query failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return result;
	}

	for (const run of reaped) {
		result.silentRunsReaped += 1;
		result.reapedRunIds.push(run.id);
		const agency = run.agency_identity;

		// AC-3: release the lease so the offer is re-dispatchable (work_failed →
		// maturity 'new' per the P934 release-reason map).
		if (run.proposal_id != null && agency) {
			try {
				await db.query(
					`UPDATE roadmap_proposal.proposal_lease
					 SET released_at = now(), release_reason = 'work_failed'
					 WHERE proposal_id = $1 AND agent_identity = $2 AND released_at IS NULL`,
					[run.proposal_id, agency],
				);
			} catch (err) {
				logger.warn(
					`[${tag}] lease release failed for run ${run.id} (proposal ${run.proposal_id}): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		if (!agency) continue;

		// AC-5: apply the P1360 spawn-failure throttle (errorClass 'timeout') so a
		// repeatedly-silent route is backed off instead of tight-loop re-dispatched.
		// Inlined (rather than calling incrementSpawnFailure) so the whole watchdog
		// runs on the one connection and is observable/rollback-able in tests.
		try {
			await db.query(
				`UPDATE roadmap_workforce.provider_registry pr
				 SET throttle_count       = throttle_count + 1,
				     recent_failure_count = recent_failure_count + 1,
				     last_failure_at      = now(),
				     status = CASE
				       WHEN throttle_count + 1 >= $2 AND pr.status = 'active' THEN 'throttled'
				       ELSE pr.status
				     END,
				     status_reason = CASE
				       WHEN throttle_count + 1 >= $2 THEN 'Spawn failure threshold exceeded (timeout: silent no-progress)'
				       ELSE pr.status_reason
				     END,
				     updated_at = now()
				 FROM roadmap_workforce.agent_registry ar
				 WHERE pr.agency_id = ar.id
				   AND ar.agent_identity = $1
				   AND pr.status NOT IN ('retired')`,
				[agency, throttleThreshold],
			);
		} catch (err) {
			logger.warn(
				`[${tag}] P1360 throttle bump failed for agency ${agency}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// AC-6: raise a silent-spawn observability alert so operators see the
		// pattern without querying agent_runs.
		try {
			await db.query(
				`INSERT INTO roadmap.agency_observability_alert_state
				   (alert_key, agency_id, alert_type, last_fired_at, cleared_at, metadata)
				 VALUES ($1, $2, 'silent_spawn', now(), NULL, $3::jsonb)
				 ON CONFLICT (alert_key) DO UPDATE
				   SET last_fired_at = now(),
				       cleared_at = NULL,
				       metadata = EXCLUDED.metadata`,
				[
					`silent_spawn:${agency}`,
					agency,
					JSON.stringify({
						run_id: run.id,
						proposal_id: run.proposal_id,
						silent_for_s: run.silent_for_s,
						no_progress_threshold_s: noProgressSec,
						detected_by: "no-progress-watchdog",
					}),
				],
			);
		} catch (err) {
			logger.warn(
				`[${tag}] silent-spawn alert write failed for agency ${agency}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (result.silentRunsReaped > 0) {
		logger.log?.(
			`[${tag}] reaped ${result.silentRunsReaped} silent no-progress run(s) (>${noProgressSec}s no progress): ${result.reapedRunIds.join(", ")}`,
		);
	}
	return result;
}
