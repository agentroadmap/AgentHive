/**
 * P444: Route pre-flight checks — host/provider/route separation.
 *
 * AC-4: resolveRoutePreflight() calls fn_resolve_route_preflight() in the DB,
 *       which atomically validates route existence, enabled status,
 *       agent_provider match, host policy, and staleness.
 *
 * AC-6: getWorktreePolicy() returns worktree_root_pattern for the given
 *       (project_id, repo_id) pair, or null if no policy applies.
 */

import { query } from "../../infra/postgres/pool.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RoutePreflightResult {
	allowed: boolean;
	/** Short diagnostic string when allowed=false; null when allowed=true. */
	reason: string | null;
}

// ─── AC-4: Route pre-flight check ────────────────────────────────────────────

/**
 * Performs the atomic pre-flight gate for a proposed spawn.
 *
 * Checks (in order, first failure wins):
 *   (a) route exists in model_routes
 *   (b) route is enabled
 *   (c) route.agent_provider matches agentProvider
 *   (d) host_model_policy allows route_provider on this host
 *   (e) route.last_validated_at is within stale_after_seconds window
 *
 * Unknown hosts (not in host_model_policy) are legacy-permitted.
 * NULL last_validated_at is treated as fresh.
 *
 * @param host          AGENTHIVE_HOST env value (e.g. "bot", "hermes")
 * @param routeId       model_routes.id resolved by resolveModelRoute()
 * @param agentProvider AgentProvider enum value (e.g. "claude", "openclaw")
 */
export async function resolveRoutePreflight(
	host: string,
	routeId: bigint,
	agentProvider: string,
): Promise<RoutePreflightResult> {
	const { rows } = await query<{ allowed: boolean; reason: string | null }>(
		`SELECT allowed, reason
         FROM roadmap.fn_resolve_route_preflight($1, $2, $3)`,
		[host, routeId.toString(), agentProvider],
	);

	if (rows.length === 0) {
		// Function returned no rows — treat as allowed (guard against empty RETURN edge)
		return { allowed: true, reason: null };
	}

	return { allowed: rows[0].allowed, reason: rows[0].reason ?? null };
}

// ─── AC-6: Worktree policy lookup ─────────────────────────────────────────────

/**
 * Returns the worktree_root_pattern for the given (project_id, repo_id) pair.
 * Null means no policy override applies; the caller should fall back to the
 * default WORKTREE_ROOT constant.
 *
 * Specificity: (project+repo) > (project only) > (repo only) > global NULL/NULL.
 *
 * @param projectId  roadmap.projects.id (or null for repo-only lookup)
 * @param repoId     control_git.worktree_policy.repo_id (or null for project-only)
 */
export async function getWorktreePolicy(
	projectId: bigint | null,
	repoId: bigint | null,
): Promise<string | null> {
	const { rows } = await query<{ worktree_root_pattern: string }>(
		`SELECT control_git.fn_worktree_policy($1, $2) AS worktree_root_pattern`,
		[
			projectId !== null ? projectId.toString() : null,
			repoId !== null ? repoId.toString() : null,
		],
	);

	return rows[0]?.worktree_root_pattern ?? null;
}
