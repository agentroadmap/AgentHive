/**
 * P269: Stale-row reaper.
 *
 * Recovers orphans left behind by abrupt stops (SIGKILL, OOM, host reboot):
 *   - transition_queue rows stuck in 'processing'
 *   - proposal_lease rows past expires_at without released_at
 *   - squad_dispatch rows stuck in 'assigned'/'active' past assigned_at + 20m
 *
 * Idempotent — safe to run from multiple services concurrently at boot.
 */

import type { Pool } from "pg";

export interface ReaperLogger {
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

export interface ReapResult {
	transitions: number;
	leases: number;
	dispatches: number;
	sequencesRealigned: number;
}

const TRANSITION_STALE_MIN = 15;
const LEASE_STALE_MIN = 10;
const DISPATCH_STALE_MIN = 20;

// Task #24/#28: schemas whose IDENTITY sequences we realign at boot.
// fn_realign_identity_sequences is a no-op when nothing drifted, so this
// is cheap to run on every orchestrator/gate-pipeline start.
const REALIGN_SCHEMAS = ["roadmap", "roadmap_workforce"] as const;

export async function reapStaleRows(
	pool: Pool,
	logger: ReaperLogger,
	tag = "Reaper",
): Promise<ReapResult> {
	const result: ReapResult = {
		transitions: 0,
		leases: 0,
		dispatches: 0,
		sequencesRealigned: 0,
	};

	try {
		const r = await pool.query(
			`UPDATE roadmap.transition_queue
			 SET status='pending',
			     processing_at=NULL,
			     last_error=COALESCE(last_error,'') || ' [reaped: stale processing >${TRANSITION_STALE_MIN}m]'
			 WHERE status='processing'
			   AND processing_at IS NOT NULL
			   AND processing_at < now() - ($1 || ' min')::interval
			 RETURNING id`,
			[String(TRANSITION_STALE_MIN)],
		);
		result.transitions = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] transition_queue reap failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

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
			`UPDATE roadmap_workforce.squad_dispatch
			 SET dispatch_status='cancelled',
			     completed_at=now(),
			     metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('reaped_at', to_jsonb(now()), 'reaped_reason', 'stale dispatch >${DISPATCH_STALE_MIN}m')
			 WHERE dispatch_status IN ('assigned','active')
			   AND assigned_at IS NOT NULL
			   AND assigned_at < now() - ($1 || ' min')::interval
			   AND completed_at IS NULL
			 RETURNING id`,
			[String(DISPATCH_STALE_MIN)],
		);
		result.dispatches = r.rowCount ?? 0;
	} catch (err) {
		logger.warn(
			`[${tag}] squad_dispatch reap failed: ${err instanceof Error ? err.message : String(err)}`,
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
		result.transitions ||
		result.leases ||
		result.dispatches ||
		result.sequencesRealigned
	) {
		logger.log(
			`[${tag}] reaped: ${result.transitions} transition(s), ${result.leases} lease(s), ${result.dispatches} dispatch(es), ${result.sequencesRealigned} sequence(s) realigned`,
		);
	} else {
		logger.log(`[${tag}] no stale rows`);
	}

	return result;
}
