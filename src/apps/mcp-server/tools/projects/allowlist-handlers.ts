/**
 * Project Allowlist MCP Tools (P484 Phase 2)
 *
 * Read and write operations for:
 * - project_route_allowlist (list, add, remove)
 * - project_capability_scope (list, set)
 * - project_budget_cap (list, set)
 *
 * Mutation handlers require operator or authority trust tier (P843).
 * All responses use the standard pagination shape:
 * { total, returned, items, [truncated], [limit] }
 */

import { query } from "../../../../postgres/pool.ts";
import { agentContextStorage } from "../../../../shared/identity/agent-context.ts";
import type { CallToolResult } from "../../types.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

function jsonResult(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

/**
 * List routes in the allowlist for a project.
 *
 * Standard pagination: total (total rows matching project), returned (length of items),
 * limit (how many we retrieved), items (the rows).
 */
export async function listRoutes(args: {
	project_id: number;
	limit?: number;
	offset?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
		const offset = Math.max(args.offset ?? 0, 0);

		const [countResult, listResult] = await Promise.all([
			query<{ total: string }>(
				`SELECT COUNT(*)::text AS total FROM roadmap.project_route_allowlist
				 WHERE project_id = $1`,
				[args.project_id]
			),
			query<{
				id: string;
				project_id: string;
				route_name: string;
				max_calls_per_day: string | null;
				max_tokens_per_day: string | null;
				created_at: string;
			}>(
				`SELECT id, project_id, route_name, max_calls_per_day, max_tokens_per_day, created_at
				 FROM roadmap.project_route_allowlist
				 WHERE project_id = $1
				 ORDER BY created_at DESC
				 LIMIT $2 OFFSET $3`,
				[args.project_id, limit, offset]
			),
		]);

		const total = Number(countResult.rows[0]?.total ?? 0);
		const items = listResult.rows.map((r) => ({
			id: Number(r.id),
			project_id: Number(r.project_id),
			route_name: r.route_name,
			max_calls_per_day: r.max_calls_per_day ? Number(r.max_calls_per_day) : null,
			max_tokens_per_day: r.max_tokens_per_day ? Number(r.max_tokens_per_day) : null,
			created_at: r.created_at,
		}));

		return jsonResult({
			total,
			returned: items.length,
			limit,
			offset,
			truncated: total > offset + items.length,
			items,
		});
	} catch (err) {
		return errorResult("Failed to list routes", err);
	}
}

/**
 * List capabilities in scope for a project.
 */
export async function listCapabilities(args: {
	project_id: number;
	limit?: number;
	offset?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
		const offset = Math.max(args.offset ?? 0, 0);

		const [countResult, listResult] = await Promise.all([
			query<{ total: string }>(
				`SELECT COUNT(*)::text AS total FROM roadmap.project_capability_scope
				 WHERE project_id = $1`,
				[args.project_id]
			),
			query<{
				id: string;
				project_id: string;
				capability_name: string;
				max_concurrency: string | null;
				created_at: string;
			}>(
				`SELECT id, project_id, capability_name, max_concurrency, created_at
				 FROM roadmap.project_capability_scope
				 WHERE project_id = $1
				 ORDER BY created_at DESC
				 LIMIT $2 OFFSET $3`,
				[args.project_id, limit, offset]
			),
		]);

		const total = Number(countResult.rows[0]?.total ?? 0);
		const items = listResult.rows.map((r) => ({
			id: Number(r.id),
			project_id: Number(r.project_id),
			capability_name: r.capability_name,
			max_concurrency: r.max_concurrency ? Number(r.max_concurrency) : null,
			created_at: r.created_at,
		}));

		return jsonResult({
			total,
			returned: items.length,
			limit,
			offset,
			truncated: total > offset + items.length,
			items,
		});
	} catch (err) {
		return errorResult("Failed to list capabilities", err);
	}
}

/**
 * List budget caps for a project.
 *
 * Note: periods are 'day', 'week', 'month'.
 */
export async function listCaps(args: {
	project_id: number;
	limit?: number;
	offset?: number;
}): Promise<CallToolResult> {
	try {
		const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
		const offset = Math.max(args.offset ?? 0, 0);

		const [countResult, listResult] = await Promise.all([
			query<{ total: string }>(
				`SELECT COUNT(*)::text AS total FROM roadmap.project_budget_cap
				 WHERE project_id = $1`,
				[args.project_id]
			),
			query<{
				id: string;
				project_id: string;
				period: string;
				max_usd_cents: string;
				created_at: string;
			}>(
				`SELECT id, project_id, period, max_usd_cents, created_at
				 FROM roadmap.project_budget_cap
				 WHERE project_id = $1
				 ORDER BY period, created_at DESC
				 LIMIT $2 OFFSET $3`,
				[args.project_id, limit, offset]
			),
		]);

		const total = Number(countResult.rows[0]?.total ?? 0);
		const items = listResult.rows.map((r) => ({
			id: Number(r.id),
			project_id: Number(r.project_id),
			period: r.period,
			max_usd_cents: Number(r.max_usd_cents),
			created_at: r.created_at,
		}));

		return jsonResult({
			total,
			returned: items.length,
			limit,
			offset,
			truncated: total > offset + items.length,
			items,
		});
	} catch (err) {
		return errorResult("Failed to list budget caps", err);
	}
}

function _checkAuthority(): { allowed: boolean; reason: string } {
	const ctx = agentContextStorage.getStore();
	if (!ctx?.verified) {
		return { allowed: true, reason: "log_only_mode" };
	}
	if (ctx.verified.principal_kind === "operator") {
		return { allowed: true, reason: "authorized" };
	}
	return { allowed: false, reason: `insufficient_principal_kind: ${ctx.verified.principal_kind}` };
}

/**
 * Add or update a route in the allowlist for a project.
 * Requires operator or authority trust tier.
 */
export async function addRoute(args: {
	project_id: number;
	route_name: string;
	max_calls_per_day?: number;
	max_tokens_per_day?: number;
}): Promise<CallToolResult> {
	const authCheck = _checkAuthority();
	if (!authCheck.allowed) {
		return errorResult("Unauthorized", `Trust tier check failed: ${authCheck.reason}`);
	}

	try {
		const result = await query<{
			id: string;
			route_name: string;
			project_id: string;
		}>(
			`INSERT INTO roadmap.project_route_allowlist
			 (project_id, route_name, max_calls_per_day, max_tokens_per_day, created_at)
			 VALUES ($1, $2, $3, $4, NOW())
			 ON CONFLICT (project_id, route_name) DO UPDATE
			   SET max_calls_per_day = EXCLUDED.max_calls_per_day,
			       max_tokens_per_day = EXCLUDED.max_tokens_per_day
			 RETURNING id, route_name, project_id`,
			[
				args.project_id,
				args.route_name,
				args.max_calls_per_day ?? null,
				args.max_tokens_per_day ?? null,
			]
		);

		const row = result.rows[0];
		return jsonResult({
			ok: true,
			route_name: row?.route_name,
			project_id: Number(row?.project_id),
			auth_mode: authCheck.reason,
		});
	} catch (err) {
		return errorResult("Failed to add route", err);
	}
}

/**
 * Remove a route from the allowlist for a project.
 * Requires operator or authority trust tier.
 */
export async function removeRoute(args: {
	project_id: number;
	route_name: string;
}): Promise<CallToolResult> {
	const authCheck = _checkAuthority();
	if (!authCheck.allowed) {
		return errorResult("Unauthorized", `Trust tier check failed: ${authCheck.reason}`);
	}

	try {
		const result = await query<{ id: string }>(
			`DELETE FROM roadmap.project_route_allowlist
			 WHERE project_id = $1 AND route_name = $2
			 RETURNING id`,
			[args.project_id, args.route_name]
		);

		const deleted = result.rows.length > 0;
		return jsonResult({
			ok: true,
			deleted,
			project_id: args.project_id,
			route_name: args.route_name,
			auth_mode: authCheck.reason,
		});
	} catch (err) {
		return errorResult("Failed to remove route", err);
	}
}

/**
 * Set or update capability scope for a project.
 * Requires operator or authority trust tier.
 */
export async function setCapabilityScope(args: {
	project_id: number;
	capability_name: string;
	max_concurrency?: number;
}): Promise<CallToolResult> {
	const authCheck = _checkAuthority();
	if (!authCheck.allowed) {
		return errorResult("Unauthorized", `Trust tier check failed: ${authCheck.reason}`);
	}

	try {
		const result = await query<{
			id: string;
			capability_name: string;
			project_id: string;
		}>(
			`INSERT INTO roadmap.project_capability_scope
			 (project_id, capability_name, max_concurrency, created_at)
			 VALUES ($1, $2, $3, NOW())
			 ON CONFLICT (project_id, capability_name) DO UPDATE
			   SET max_concurrency = EXCLUDED.max_concurrency
			 RETURNING id, capability_name, project_id`,
			[args.project_id, args.capability_name, args.max_concurrency ?? null]
		);

		const row = result.rows[0];
		return jsonResult({
			ok: true,
			capability_name: row?.capability_name,
			project_id: Number(row?.project_id),
			auth_mode: authCheck.reason,
		});
	} catch (err) {
		return errorResult("Failed to set capability scope", err);
	}
}

/**
 * Set or update a budget cap for a project.
 * Requires operator or authority trust tier.
 */
export async function setBudgetCap(args: {
	project_id: number;
	period: "day" | "week" | "month";
	max_usd_cents: number;
}): Promise<CallToolResult> {
	const authCheck = _checkAuthority();
	if (!authCheck.allowed) {
		return errorResult("Unauthorized", `Trust tier check failed: ${authCheck.reason}`);
	}

	if (!["day", "week", "month"].includes(args.period)) {
		return errorResult("Invalid period", `Period must be one of: day, week, month`);
	}

	try {
		const result = await query<{ id: string; period: string }>(
			`INSERT INTO roadmap.project_budget_cap
			 (project_id, period, max_usd_cents, created_at)
			 VALUES ($1, $2, $3, NOW())
			 ON CONFLICT (project_id, period) DO UPDATE
			   SET max_usd_cents = EXCLUDED.max_usd_cents
			 RETURNING id, period`,
			[args.project_id, args.period, args.max_usd_cents]
		);

		const row = result.rows[0];
		return jsonResult({
			ok: true,
			period: row?.period,
			max_usd_cents: args.max_usd_cents,
			project_id: args.project_id,
			auth_mode: authCheck.reason,
		});
	} catch (err) {
		return errorResult("Failed to set budget cap", err);
	}
}
