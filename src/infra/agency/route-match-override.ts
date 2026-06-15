/**
 * P3313 AC-5: operator override surface for adaptive route matching.
 *
 * One audited code path shared by the CLI (scripts/route-match-override.ts) and
 * any future MCP tool. Operators can:
 *   - PIN   a route for a task_class  (force the matcher to pick it)
 *   - BAN   a route for a task_class  (exclude it)
 *   - CLEAR an active override
 *   - LIST  active overrides + recent match decisions + per-(model,task_class) reliability
 *
 * Backed by roadmap_workforce.route_match_override (migration 268). created_by /
 * cleared_by are required so every override is attributable (audited).
 */

import { query } from "../postgres/pool.ts";

export type OverrideMode = "pin" | "ban";

type Exec = (sql: string, params?: unknown[]) => Promise<unknown>;

export interface SetOverrideInput {
	taskClass: string;
	routeId: number;
	mode: OverrideMode;
	createdBy: string; // audited actor — required
	reason?: string;
	expiresAt?: string | null; // ISO timestamp, NULL = until cleared
	exec?: Exec;
}

export interface OverrideRow {
	id: number;
	task_class: string;
	route_id: number;
	mode: OverrideMode;
	reason: string;
	created_by: string;
	created_at: string;
	expires_at: string | null;
}

/**
 * Create or replace the active override for (task_class, route_id).
 * Re-running with a different mode/reason supersedes the prior active row
 * (clears it first so the unique partial index is respected) — fully audited.
 */
export async function setOverride(
	input: SetOverrideInput,
): Promise<OverrideRow> {
	const exec = input.exec ?? query;
	if (!input.createdBy || input.createdBy.trim() === "") {
		throw new Error("setOverride: createdBy is required (audited actor)");
	}
	await exec("BEGIN");
	try {
		// Supersede any existing active override on this (task_class, route_id).
		await exec(
			`UPDATE roadmap_workforce.route_match_override
			    SET cleared_at = now(), cleared_by = $3
			  WHERE task_class = $1 AND route_id = $2 AND cleared_at IS NULL`,
			[input.taskClass, input.routeId, input.createdBy],
		);
		const res = (await exec(
			`INSERT INTO roadmap_workforce.route_match_override
			   (task_class, route_id, mode, reason, created_by, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id, task_class, route_id, mode, reason, created_by,
			           created_at, expires_at`,
			[
				input.taskClass,
				input.routeId,
				input.mode,
				input.reason ?? "",
				input.createdBy,
				input.expiresAt ?? null,
			],
		)) as { rows: OverrideRow[] };
		await exec("COMMIT");
		return res.rows[0];
	} catch (err) {
		await exec("ROLLBACK").catch(() => {});
		throw err;
	}
}

/** Clear the active override for (task_class, route_id). Returns rows cleared. */
export async function clearOverride(
	taskClass: string,
	routeId: number,
	clearedBy: string,
	exec: Exec = query,
): Promise<number> {
	if (!clearedBy || clearedBy.trim() === "") {
		throw new Error("clearOverride: clearedBy is required (audited actor)");
	}
	const res = (await exec(
		`UPDATE roadmap_workforce.route_match_override
		    SET cleared_at = now(), cleared_by = $3
		  WHERE task_class = $1 AND route_id = $2 AND cleared_at IS NULL`,
		[taskClass, routeId, clearedBy],
	)) as { rowCount?: number };
	return res.rowCount ?? 0;
}

/** List currently active (non-cleared, non-expired) overrides. */
export async function listActiveOverrides(
	taskClass?: string,
	exec: Exec = query,
): Promise<OverrideRow[]> {
	const res = (await exec(
		`SELECT id, task_class, route_id, mode, reason, created_by,
		        created_at, expires_at
		   FROM roadmap_workforce.route_match_override
		  WHERE cleared_at IS NULL
		    AND (expires_at IS NULL OR expires_at > now())
		    AND ($1::text IS NULL OR task_class = $1)
		  ORDER BY task_class, route_id`,
		[taskClass ?? null],
	)) as { rows: OverrideRow[] };
	return res.rows;
}

/**
 * Effective override decision for the matcher (P3312 reads this):
 *   - banned route ids for a task_class
 *   - pinned route id (if any) for a task_class
 */
export async function getEffectiveOverrides(
	taskClass: string,
	exec: Exec = query,
): Promise<{ pinnedRouteId: number | null; bannedRouteIds: number[] }> {
	const rows = await listActiveOverrides(taskClass, exec);
	const pinned = rows.find((r) => r.mode === "pin");
	return {
		pinnedRouteId: pinned ? pinned.route_id : null,
		bannedRouteIds: rows.filter((r) => r.mode === "ban").map((r) => r.route_id),
	};
}

/** Recent match decisions for the dashboard panel (AC-5). */
export async function recentMatchDecisions(
	limit = 50,
	exec: Exec = query,
): Promise<Record<string, unknown>[]> {
	const res = (await exec(
		`SELECT * FROM roadmap_workforce.v_match_decisions LIMIT $1`,
		[limit],
	)) as { rows: Record<string, unknown>[] };
	return res.rows;
}

/** Per-(scope,task_class) reliability summary for the dashboard panel (AC-5). */
export async function reliabilitySummary(
	scopeType: "model" | "agency" | "route" = "model",
	exec: Exec = query,
): Promise<Record<string, unknown>[]> {
	const res = (await exec(
		`SELECT scope_key, task_class, score, sample_count, confidence
		   FROM roadmap_workforce.v_reliability_summary
		  WHERE scope_type = $1
		  ORDER BY task_class, score DESC`,
		[scopeType],
	)) as { rows: Record<string, unknown>[] };
	return res.rows;
}
