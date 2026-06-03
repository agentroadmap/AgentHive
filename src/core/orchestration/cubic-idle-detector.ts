/**
 * Cubic Idle Detector (P196)
 *
 * Detects idle and stale cubics using the cubic_state lifecycle table.
 * Cubic lifecycle: ACTIVE → IDLE → COMPLETED → STALE → ARCHIVED
 *
 * - IDLE_TIMEOUT: 5 minutes of inactivity → mark IDLE
 * - STALE_TIMEOUT: 30 minutes in IDLE/COMPLETED → eligible for cleanup
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";
import type { QueryRunner } from "./cubic-cleanup.ts";

export interface IdleCubic {
	cubic_id: string;
	lifecycle_status: string;
	last_activity_at: string;
	idle_since: string | null;
}

export interface CubicLifecycleStats {
	lifecycle_status: string;
	count: number;
	oldest_activity: string | null;
	newest_activity: string | null;
}

export class CubicIdleDetector {
	static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
	static readonly STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

	private readonly query: QueryRunner;

	constructor(options?: { query?: QueryRunner }) {
		this.query = options?.query ?? defaultQuery;
	}

	/**
	 * Find cubics that should be marked IDLE (active but no recent activity).
	 */
	async detectIdleCubics(): Promise<IdleCubic[]> {
		const idleThreshold = new Date(
			Date.now() - CubicIdleDetector.IDLE_TIMEOUT_MS,
		);

		const { rows } = await this.query<IdleCubic>(
			`SELECT cs.cubic_id, cs.lifecycle_status, cs.last_activity_at, cs.idle_since
			 FROM roadmap.cubic_state cs
			 WHERE cs.lifecycle_status = 'ACTIVE'
			   AND cs.last_activity_at < $1
			   AND cs.phase != 'RUNNING'`,
			[idleThreshold.toISOString()],
		);

		return rows;
	}

	/**
	 * Find cubics eligible for cleanup (idle/completed and stale).
	 */
	async detectStaleCubics(): Promise<IdleCubic[]> {
		const staleThreshold = new Date(
			Date.now() - CubicIdleDetector.STALE_TIMEOUT_MS,
		);

		const { rows } = await this.query<IdleCubic>(
			`SELECT cs.cubic_id, cs.lifecycle_status, cs.last_activity_at, cs.idle_since
			 FROM roadmap.cubic_state cs
			 WHERE cs.lifecycle_status IN ('IDLE', 'COMPLETED')
			   AND cs.last_activity_at < $1`,
			[staleThreshold.toISOString()],
		);

		return rows;
	}

	/**
	 * Mark a cubic as IDLE with idle_since timestamp.
	 */
	async markIdle(cubicId: string): Promise<void> {
		await this.query(
			`UPDATE roadmap.cubic_state
			 SET lifecycle_status = 'IDLE',
			     idle_since = COALESCE(idle_since, NOW()),
			     phase = 'IDLE'
			 WHERE cubic_id = $1`,
			[cubicId],
		);
	}

	/**
	 * Mark a cubic as COMPLETED.
	 */
	async markCompleted(cubicId: string): Promise<void> {
		await this.query(
			`UPDATE roadmap.cubic_state
			 SET lifecycle_status = 'COMPLETED',
			     phase = 'COMPLETED'
			 WHERE cubic_id = $1`,
			[cubicId],
		);
	}

	/**
	 * Mark a cubic as ARCHIVED (terminal state).
	 */
	async markArchived(cubicId: string): Promise<void> {
		await this.query(
			`UPDATE roadmap.cubic_state
			 SET lifecycle_status = 'ARCHIVED'
			 WHERE cubic_id = $1`,
			[cubicId],
		);
	}

	/**
	 * Update activity timestamp — resets idle/stale tracking without touching phase.
	 * Called on cubic focus, acquire, or any agent action.
	 * NOTE: does NOT update phase — callers own phase transitions.
	 */
	async updateActivity(cubicId: string): Promise<void> {
		await this.query(
			`UPDATE roadmap.cubic_state
			 SET last_activity_at = NOW(),
			     lifecycle_status = 'ACTIVE',
			     idle_since = NULL
			 WHERE cubic_id = $1`,
			[cubicId],
		);
	}

	/**
	 * Get lifecycle stats grouped by status.
	 */
	async getStats(): Promise<CubicLifecycleStats[]> {
		const { rows } = await this.query<CubicLifecycleStats>(
			`SELECT
				lifecycle_status,
				COUNT(*)::int as count,
				MIN(last_activity_at)::text as oldest_activity,
				MAX(last_activity_at)::text as newest_activity
			 FROM roadmap.cubic_state
			 GROUP BY lifecycle_status
			 ORDER BY
				CASE lifecycle_status
					WHEN 'ACTIVE' THEN 1
					WHEN 'IDLE' THEN 2
					WHEN 'COMPLETED' THEN 3
					WHEN 'STALE' THEN 4
					WHEN 'ARCHIVED' THEN 5
				END`,
		);

		return rows;
	}

	/**
	 * Sync cubic_state from cubics table status.
	 * Fixes drift between the two tables.
	 */
	async syncFromCubics(): Promise<number> {
		const { rows } = await this.query<{ cnt: number }>(
			`UPDATE roadmap.cubic_state cs
			 SET lifecycle_status = CASE
				WHEN c.status = 'active' THEN 'ACTIVE'
				WHEN c.status = 'idle' THEN 'IDLE'
				WHEN c.status = 'complete' THEN 'COMPLETED'
				WHEN c.status = 'expired' THEN 'ARCHIVED'
				ELSE cs.lifecycle_status
			 END,
			 phase = CASE
				WHEN c.status = 'active' THEN 'RUNNING'
				WHEN c.status = 'idle' THEN 'IDLE'
				WHEN c.status = 'complete' THEN 'COMPLETED'
				ELSE cs.phase
			 END
			 FROM roadmap.cubics c
			 WHERE cs.cubic_id = c.cubic_id
			   AND cs.lifecycle_status != CASE
				WHEN c.status = 'active' THEN 'ACTIVE'
				WHEN c.status = 'idle' THEN 'IDLE'
				WHEN c.status = 'complete' THEN 'COMPLETED'
				WHEN c.status = 'expired' THEN 'ARCHIVED'
				ELSE cs.lifecycle_status
			 END
			 RETURNING cs.cubic_id`,
		);

		return rows.length;
	}
}
