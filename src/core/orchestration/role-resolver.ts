/**
 * P748: Queue-role resolver.
 *
 * Resolves the ordered list of agent role profiles for a given
 * (workflow_template_id, stage, maturity) queue key, with optional
 * project-level overrides.
 *
 * Two-tier lookup:
 *   1. DB: roadmap.agent_role_profile — project rows shadow global rows for
 *      the same role name.
 *   2. BUILTIN_FALLBACK — legacy STAGE_DISPATCH_ROLES literal map (same
 *      semantics as pipeline-cron.ts). Used when the DB is empty or
 *      unreachable.
 *
 * Phase 1 (P748): shadow-mode. Callers that still use STAGE_DISPATCH_ROLES
 * literals may call shadowCheck() to log divergence. Phase 2 deletes the
 * legacy literals once ≥24h shadow-mode zero-divergence window is observed.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface QueueKey {
	workflowTemplateId: number;
	stage: string;
	maturity: string;
	projectId?: number | null;
}

export interface RoleProfile {
	role: string;
	requiredCapabilities: string[];
	allowedRouteProviders: string[] | null;
	forbiddenRouteProviders: string[] | null;
	promptTemplate: unknown | null;
	priority: number;
	source: "db" | "builtin-fallback";
}

// ─── Legacy fallback ─────────────────────────────────────────────────────────
// Mirrors STAGE_DISPATCH_ROLES in pipeline-cron.ts.
// prep → new/active maturity (build agents); gate → mature maturity (reviewers).

const STAGE_DISPATCH_ROLES: Record<
	string,
	{ prep: string[]; gate: string[] }
> = {
	DRAFT: {
		prep: ["researcher", "architect"],
		gate: ["architect", "reviewer-d1", "reviewer"],
	},
	REVIEW: {
		prep: ["architect", "skeptic"],
		gate: ["skeptic-alpha", "reviewer-d2", "architect"],
	},
	DEVELOP: {
		prep: ["developer", "engineer"],
		gate: ["skeptic-beta", "reviewer-d3", "qa"],
	},
	MERGE: {
		prep: ["qa", "integration"],
		gate: ["reviewer-d4", "qa", "maintainer", "gate-agent"],
	},
};

function builtinFallback(stage: string, maturity: string): RoleProfile[] {
	const set = STAGE_DISPATCH_ROLES[stage.toUpperCase()];
	if (!set) return [];
	const roles = maturity === "mature" ? set.gate : set.prep;
	return roles.map((role, idx) => ({
		role,
		requiredCapabilities: [],
		allowedRouteProviders: null,
		forbiddenRouteProviders: null,
		promptTemplate: null,
		priority: (idx + 1) * 10,
		source: "builtin-fallback" as const,
	}));
}

// ─── DB resolver ─────────────────────────────────────────────────────────────

const SQL_ROLES = `
SELECT role,
       required_capabilities,
       allowed_route_providers,
       forbidden_route_providers,
       prompt_template,
       priority
FROM (
    SELECT DISTINCT ON (role)
           role,
           required_capabilities,
           allowed_route_providers,
           forbidden_route_providers,
           prompt_template,
           priority,
           scope
    FROM roadmap.agent_role_profile
    WHERE workflow_template_id = $1
      AND stage                = $2
      AND maturity             = $3
      AND (
            scope = 'global'
            OR (scope = 'project' AND project_id = $4)
          )
    ORDER BY role,
             CASE WHEN scope = 'project' THEN 0 ELSE 1 END,
             priority ASC
) t
ORDER BY priority ASC
`;

/**
 * Resolve agent role profiles for the given queue key.
 *
 * Returns profiles ordered by priority ASC (lowest number dispatched first).
 * Project-scoped rows shadow global rows for the same role name.
 * Falls back to BUILTIN_FALLBACK when the DB returns no rows.
 *
 * @param key  - (workflowTemplateId, stage, maturity, projectId?)
 * @param queryFn - Injectable query function; defaults to the shared pool.
 *                  Pass a stub during tests to avoid hitting the database.
 */
export async function getRolesForQueue(
	key: QueueKey,
	queryFn: QueryFn = defaultQuery,
): Promise<RoleProfile[]> {
	const { workflowTemplateId, stage, maturity, projectId = null } = key;

	try {
		const { rows } = await queryFn(SQL_ROLES, [
			workflowTemplateId,
			stage.toUpperCase(),
			maturity,
			projectId,
		]);

		if (rows.length > 0) {
			return rows.map((r) => ({
				role: String(r.role),
				requiredCapabilities: (r.required_capabilities as string[]) ?? [],
				allowedRouteProviders:
					(r.allowed_route_providers as string[] | null) ?? null,
				forbiddenRouteProviders:
					(r.forbidden_route_providers as string[] | null) ?? null,
				promptTemplate: r.prompt_template ?? null,
				priority: Number(r.priority),
				source: "db" as const,
			}));
		}
	} catch (err) {
		console.warn(
			`[RoleResolver] DB query failed for (wft=${workflowTemplateId}, stage=${stage}, maturity=${maturity}), using BUILTIN_FALLBACK:`,
			err instanceof Error ? err.message : err,
		);
	}

	return builtinFallback(stage, maturity);
}

/**
 * Shadow-mode divergence check.
 *
 * Compares a caller's legacy role list against the DB-resolved profiles and
 * logs when they differ. Used during the transition window so callers that
 * still use STAGE_DISPATCH_ROLES can identify drift without breaking anything.
 *
 * Remove once all callers route through getRolesForQueue() (P748 Phase 2).
 */
export async function shadowCheck(
	key: QueueKey,
	legacyRoles: string[],
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	try {
		const profiles = await getRolesForQueue(key, queryFn);
		const dbRoles = profiles.map((p) => p.role);
		const legacySet = new Set(legacyRoles);
		const dbSet = new Set(dbRoles);

		const onlyInLegacy = legacyRoles.filter((r) => !dbSet.has(r));
		const onlyInDb = dbRoles.filter((r) => !legacySet.has(r));

		if (onlyInLegacy.length > 0 || onlyInDb.length > 0) {
			console.warn(
				`[RoleResolver] shadow divergence (wft=${key.workflowTemplateId}, stage=${key.stage}, maturity=${key.maturity}):`,
				{ onlyInLegacy, onlyInDb },
			);
		}
	} catch {
		// Shadow checks must never throw — they're observability-only.
	}
}
