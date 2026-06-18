/**
 * P269: Stale-row reaper.
 *
 * Recovers orphans left behind by abrupt stops (SIGKILL, OOM, host reboot):
 *   - proposal_lease rows past expires_at without released_at
 *   - squad_dispatch rows stuck in 'assigned'/'active' past assigned_at + 20m
 *
 * P753 retired transition_queue reaping; the unified scanner replaces it.
 *
 * Idempotent — safe to run from multiple services concurrently at boot.
 */

import type { Pool } from "pg";
import { reapOrphanScratch } from "../../shared/utils/agent-scratch.ts";
import { reapSilentNoProgressRuns } from "./no-progress-watchdog.ts";
import { detectAndReapSilentSpawns } from "./silent-spawn-watchdog.ts";

export interface ReaperLogger {
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

export interface ReapResult {
	leases: number;
	dispatches: number;
	zombieRunsTimedOut: number;
	/** P3847 Part B: runs reaped early by the silent no-progress watchdog. */
	silentRunsReaped: number;
	silentSpawnsTimedOut: number;
	sequencesRealigned: number;
	pokeAttemptsPruned: number;
	lifecycleLogPruned: number;
	scratchDirs: number;
	holdWakesCleared: number;
}

const LEASE_STALE_MIN = 10;
const DISPATCH_STALE_MIN = 20;
// Agent runs still 'running' past this threshold are zombies (agency crashed and
// re-registered without closing the run). 60 min is safely past the 20-min
// squad_dispatch reaper, so any surviving 'running' row is orphaned.
const AGENT_RUN_ZOMBIE_MIN = 60;
const POKE_ATTEMPT_RETENTION_DAYS = 7;
const LIFECYCLE_LOG_RETENTION_DAYS = Number(
	process.env.LIFECYCLE_LOG_RETENTION_DAYS ?? "30",
);

// Task #24/#28: schemas whose IDENTITY sequences we realign at boot.
// fn_realign_identity_sequences is a no-op when nothing drifted, so this
// is cheap to run on every orchestrator start.
const REALIGN_SCHEMAS = ["roadmap", "roadmap_workforce"] as const;

export async function reapStaleRows(
	pool: Pool,
	logger: ReaperLogger,
	tag = "Reaper",
): Promise<ReapResult> {
	const result: ReapResult = {
		leases: 0,
		dispatches: 0,
		zombieRunsTimedOut: 0,
		silentRunsReaped: 0,
		silentSpawnsTimedOut: 0,
		sequencesRealigned: 0,
		pokeAttemptsPruned: 0,
		lifecycleLogPruned: 0,
		scratchDirs: 0,
		holdWakesCleared: 0,
	};

	// P404: two-phase boot scan — dry-run first (audit log), then real reap.
	// This catches rows missed while the pg_notify listener was offline (AC-19).
	try {
		await reapOrphanScratch({ dryRun: true });
		result.scratchDirs = await reapOrphanScratch();
	} catch (err) {
		logger.warn(
			`[${tag}] orphan scratch reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		// P934: replaced the COALESCE(release_reason,'') || ' [reaped: ...]'
		// append with a canonical assignment. The append produced unbounded
		// release_reason values (cleanup of 3,806 oversized rows confirmed
		// the source). Reaped leases map to 'lease_expired' (incomplete
		// bucket → maturity='new').
		//
		// P671 AC-4, AC-5: For each reaped lease, insert a proposal_discussions entry
		// with context_prefix='lease-overrun' and increment overrun_count on the proposal.
		// If overrun_count >= 2, set oversized=TRUE.
		const reaperQuery = `
			WITH reaped_leases AS (
				SELECT pl.id, pl.proposal_id, pl.agent_identity, pl.expires_at
				FROM roadmap_proposal.proposal_lease pl
				WHERE pl.released_at IS NULL
				  AND pl.expires_at IS NOT NULL
				  AND pl.expires_at < now() - ($1 || ' min')::interval
			),
			updated_leases AS (
				UPDATE roadmap_proposal.proposal_lease
				SET released_at = now(),
					release_reason = 'lease_expired'
				WHERE id IN (SELECT id FROM reaped_leases)
				RETURNING id, proposal_id, agent_identity, expires_at
			),
			increment_overruns AS (
				UPDATE roadmap_proposal.proposal p
				SET overrun_count = overrun_count + 1
				WHERE p.id IN (SELECT proposal_id FROM updated_leases)
				RETURNING id, overrun_count
			),
			mark_oversized AS (
				UPDATE roadmap_proposal.proposal p
				SET oversized = TRUE
				WHERE p.id IN (SELECT id FROM increment_overruns WHERE overrun_count >= 2)
				RETURNING id
			),
			insert_discussions AS (
				INSERT INTO roadmap_proposal.proposal_discussions
					(proposal_id, author_identity, context_prefix, body, project_id)
				SELECT
					ul.proposal_id,
					'system/reaper',
					'lease-overrun',
					json_build_object(
						'lease_id', ul.id,
						'agent_identity', ul.agent_identity,
						'expires_at', ul.expires_at,
						'reaped_at', now()
					)::text,
					1
				FROM updated_leases ul
				RETURNING id
			)
			SELECT COUNT(*) as reaped_count FROM updated_leases
		`;
		const r = await pool.query(reaperQuery, [String(LEASE_STALE_MIN)]);
		result.leases = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] proposal_lease reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const r = await pool.query(
			`UPDATE roadmap_workforce.squad_dispatch sd
			 SET dispatch_status='cancelled',
			     completed_at=now(),
			     metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('reaped_at', to_jsonb(now()), 'reaped_reason', 'stale dispatch >${DISPATCH_STALE_MIN}m')
			 WHERE dispatch_status IN ('assigned','active')
			   AND assigned_at IS NOT NULL
			   AND assigned_at < now() - ($1 || ' min')::interval
			   AND completed_at IS NULL
			   AND paused_at_provider_limit IS NOT TRUE
			   AND NOT EXISTS (
			     SELECT 1 FROM roadmap.liaison_poke_attempt lpa
			     WHERE lpa.agency_id = sd.agent_identity
			       AND lpa.outcome IS NULL
			   )
			 RETURNING id`,
			[String(DISPATCH_STALE_MIN)],
		);
		result.dispatches = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] squad_dispatch reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P309: Cancel blocked dispatches that have completed_at set.
	// These escape the above reap (which requires completed_at IS NULL).
	// Note: blocked dispatches indicate SpawnPolicyViolation or host routing failures
	// and should be reaped to avoid accumulation in workflow state.
	try {
		const r = await pool.query(
			`UPDATE roadmap_workforce.squad_dispatch
			 SET dispatch_status='cancelled',
			     metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('reaped_at', to_jsonb(now()), 'reaped_reason', 'blocked+completed cleanup')
			 WHERE dispatch_status='blocked'
			   AND completed_at IS NOT NULL
			 RETURNING id`,
		);
		result.dispatches += r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] blocked dispatch reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P1682 AC-5: Wake sweep — clear paused_at_provider_limit for holds that have expired
	// Held dispatches have paused_at_provider_limit=true and metadata.resume_eligible_at set.
	// When resume_eligible_at <= now(), the hold window has passed and dispatch can proceed.
	try {
		const r = await pool.query(
			`UPDATE roadmap_workforce.squad_dispatch
			 SET paused_at_provider_limit = false,
			     metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('hold_woken_at', to_jsonb(now()::text))
			 WHERE paused_at_provider_limit = true
			   AND (metadata->>'resume_eligible_at')::timestamp WITH TIME ZONE <= now()
			   AND dispatch_status IN ('claimed','assigned','active')
			 RETURNING id`,
		);
		result.holdWakesCleared = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] P1682 AC-5 hold wake sweep failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P3847 Part B: silent no-progress watchdog. Reap status='running' runs that
	// have shown NO progress (no tool-call/checkpoint activity AND only bare
	// 'persona=<x>' output) for AGENTHIVE_SPAWN_NO_PROGRESS_MS — well before the
	// 60-min zombie threshold below — releasing the lease, applying the P1360
	// throttle, and raising a silent-spawn alert. Runs disjoint from the zombie
	// reaper (which handles >60-min orphans).
	try {
		const watchdog = await reapSilentNoProgressRuns(pool, logger, { tag });
		result.silentRunsReaped = watchdog.silentRunsReaped;
	} catch (err) {
		logger.warn(
			`[${tag}] silent no-progress watchdog failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Reap zombie agent_runs: agencies that crashed/restarted without closing their run
	// record. Surviving 'running' rows permanently block fresh dispatch via the gate
	// check in legacy-dispatch.ts (WHERE proposal_id=$1 AND status='running').
	try {
		const r = await pool.query(
			`UPDATE roadmap_workforce.agent_runs
			 SET status = 'timeout',
			     completed_at = now(),
			     error_detail = 'Reaped by orchestrator: exceeded ${AGENT_RUN_ZOMBIE_MIN}-minute zombie threshold (agency restarted without completing run)'
			 WHERE status = 'running'
			   AND started_at < now() - ($1 || ' min')::interval
			 RETURNING id`,
			[String(AGENT_RUN_ZOMBIE_MIN)],
		);
		result.zombieRunsTimedOut = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] zombie agent_run reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P3847 AC-3/4: Detect and reap silent spawns (no tool calls within threshold).
	// Runs after the 60-min zombie reaper — these fire at 5 min and are NOT zombies,
	// they are live processes that never made progress (MCP init failure, prompt loop, etc).
	try {
		const silentResult = await detectAndReapSilentSpawns(pool, logger, tag);
		result.silentSpawnsTimedOut = silentResult.silentSpawnsTimedOut;
	} catch (err) {
		logger.warn(
			`[${tag}] silent spawn watchdog failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P251: Prune resolved poke_attempt rows older than retention window (AC-2).
	try {
		const r = await pool.query(
			`DELETE FROM roadmap.liaison_poke_attempt
			 WHERE outcome IS NOT NULL
			   AND resolved_at < now() - ($1 || ' days')::interval
			 RETURNING id`,
			[String(POKE_ATTEMPT_RETENTION_DAYS)],
		);
		result.pokeAttemptsPruned = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] poke_attempt pruning failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// P251: Prune agent_lifecycle_log rows older than retention window (AC-10).
	try {
		const r = await pool.query(
			`DELETE FROM roadmap.agent_lifecycle_log
			 WHERE event_at < now() - ($1 || ' days')::interval
			 RETURNING id`,
			[String(LIFECYCLE_LOG_RETENTION_DAYS)],
		);
		result.lifecycleLogPruned = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] agent_lifecycle_log pruning failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Task #24/#28: realign any IDENTITY sequences that drifted while we
	// were down. Migration 037 installed fn_realign_identity_sequences which
	// only moves sequences where max(col) > last_value, so this is a no-op
	// on healthy fleets and cheap enough to run every boot.
	for (const schema of REALIGN_SCHEMAS) {
		try {
			const r = await pool.query(
				"SELECT table_name, old_last_value, new_last_value FROM roadmap.fn_realign_identity_sequences($1)",
				[schema],
			);
			if (r.rowCount && r.rowCount > 0) {
				result.sequencesRealigned += r.rowCount;
				for (const row of r.rows) {
					logger.warn(
						`[${tag}] realigned ${schema}.${row.table_name}: ${row.old_last_value} -> ${row.new_last_value}`,
					);
				}
			}
		} catch (err) {
			logger.warn(
				`[${tag}] sequence realign failed for ${schema}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (
		result.leases ||
		result.dispatches ||
		result.zombieRunsTimedOut ||
		result.silentSpawnsTimedOut ||
		result.sequencesRealigned ||
		result.pokeAttemptsPruned ||
		result.lifecycleLogPruned ||
		result.scratchDirs ||
		result.holdWakesCleared
	) {
		logger.log(
			`[${tag}] reaped: ${result.leases} lease(s), ${result.dispatches} dispatch(es), ${result.zombieRunsTimedOut} zombie run(s), ${result.silentSpawnsTimedOut} silent run(s), ${result.sequencesRealigned} sequence(s) realigned, ${result.pokeAttemptsPruned} poke_attempt(s) pruned, ${result.lifecycleLogPruned} lifecycle_log row(s) pruned, ${result.scratchDirs} scratch dir(s) reaped, ${result.holdWakesCleared} hold(s) woken`,
		);
	} else {
		logger.log(`[${tag}] no stale rows`);
	}

	return result;
}
