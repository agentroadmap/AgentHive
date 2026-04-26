/**
 * Project Allowlist MCP Tools (P484 Phase 1)
 *
 * Read-only listing for:
 * - project_route_allowlist
 * - project_capability_scope
 * - project_budget_cap
 *
 * Mutation verbs (add_route, set_capability_scope, set_budget_cap) are deferred to Phase 2
 * pending P472 operator-token authorization implementation.
 *
 * All responses use the standard pagination shape:
 * { total, returned, items, [truncated], [limit] }
 */

import { query } from "../../../../postgres/pool.ts";
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
