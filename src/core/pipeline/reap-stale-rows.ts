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

export interface ReaperLogger {
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

export interface ReapResult {
	leases: number;
	dispatches: number;
	sequencesRealigned: number;
	pokeAttemptsPruned: number;
	lifecycleLogPruned: number;
}

const LEASE_STALE_MIN = 10;
const DISPATCH_STALE_MIN = 20;
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
		sequencesRealigned: 0,
		pokeAttemptsPruned: 0,
		lifecycleLogPruned: 0,
	};

	try {
		const r = await pool.query(
			`UPDATE roadmap_proposal.proposal_lease
			 SET released_at=now(),
			     release_reason=COALESCE(release_reason,'') || ' [reaped: lease expired without release]'
			 WHERE released_at IS NULL
			   AND expires_at IS NOT NULL
			   AND expires_at < now() - ($1 || ' min')::interval
			 RETURNING id`,
			[String(LEASE_STALE_MIN)],
		);
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
		result.sequencesRealigned ||
		result.pokeAttemptsPruned ||
		result.lifecycleLogPruned
	) {
		logger.log(
			`[${tag}] reaped: ${result.leases} lease(s), ${result.dispatches} dispatch(es), ${result.sequencesRealigned} sequence(s) realigned, ${result.pokeAttemptsPruned} poke_attempt(s) pruned, ${result.lifecycleLogPruned} lifecycle_log row(s) pruned`,
		);
	} else {
		logger.log(`[${tag}] no stale rows`);
	}

	return result;
}
