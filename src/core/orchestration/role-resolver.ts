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
 *      semantics as the historical gate-pipeline role registry, retired by
 *      P754). Used when the DB is empty or unreachable.
 *
 * Phase 1 (P748): shadow-mode. Callers that still use STAGE_DISPATCH_ROLES
 * literals may call shadowCheck() to log divergence. Phase 2 deletes the
 * legacy literals once ≥24h shadow-mode zero-divergence window is observed.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * P3840 Part 2: the capability that marks a role as a DELIBERATE gate-review
 * offer (vs. a build/work role). Roles carrying this capability are only
 * resolvable when AGENTHIVE_DELIBERATE_GATE_OFFERS_ENABLED is ON; otherwise
 * getRolesForQueue filters them out so behavior is exactly pre-P3840.
 *
 * Exported so the gate-offer pipeline, the gate-desk capability seed, and tests
 * all reference the single source of truth for the job name.
 */
export const GATE_REVIEW_CAPABILITY = "gate_review";

/** Injectable flag resolver — async predicate returning the master flag. */
export type FlagFn = () => Promise<boolean>;

/**
 * Resolve the P3840 deliberate-gate-offers master flag with the standard
 * env>DB>default cascade. Fails to OFF on any error so role resolution never
 * wedges (mirrors isGateAuthorityEnabled in gate-authority.ts).
 */
export async function isDeliberateGateOffersEnabled(): Promise<boolean> {
	const env = process.env.AGENTHIVE_DELIBERATE_GATE_OFFERS_ENABLED;
	if (env !== undefined) {
		return env === "1" || env.toLowerCase() === "true";
	}
	try {
		return (
			(await runtimeConfig.get(FlagKeys.DELIBERATE_GATE_OFFERS_ENABLED)) === true
		);
	} catch {
		return false; // default OFF
	}
}

/** True when a role profile is a deliberate gate-review role (P3840). */
function isGateReviewRole(p: RoleProfile): boolean {
	return (p.requiredCapabilities ?? []).includes(GATE_REVIEW_CAPABILITY);
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface QueueKey {
	workflowTemplateId: number;
	stage: string;
	maturity: string;
	projectId?: number | null;
}

export interface RoleProfile {
	id: number | null;
	role: string;
	requiredCapabilities: string[];
	allowedRouteProviders: string[] | null;
	forbiddenRouteProviders: string[] | null;
	promptTemplate: unknown | null;
	priority: number;
	source: "db" | "builtin-fallback";
}

// ─── Legacy fallback ─────────────────────────────────────────────────────────
// Mirrors the historical STAGE_DISPATCH_ROLES (retired with gate-pipeline in P754).
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
		id: null,
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
SELECT id,
       role,
       required_capabilities,
       allowed_route_providers,
       forbidden_route_providers,
       prompt_template,
       priority
FROM (
    SELECT DISTINCT ON (role)
           id,
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
	flagFn: FlagFn = isDeliberateGateOffersEnabled,
): Promise<RoleProfile[]> {
	const { workflowTemplateId, stage, maturity, projectId = null } = key;

	// P3840 Part 2: resolve the deliberate-gate-offers master flag once. When OFF
	// (default), gate-review roles are filtered out below so behavior is exactly
	// pre-P3840 (no gate offers post). Fails to OFF on error.
	let deliberateGateEnabled = false;
	try {
		deliberateGateEnabled = await flagFn();
	} catch {
		deliberateGateEnabled = false;
	}

	// Drop gate-review roles unless the flag is ON. Always applied (DB + fallback)
	// so the dormant-by-default contract holds regardless of resolution source.
	const applyGateFilter = (profiles: RoleProfile[]): RoleProfile[] =>
		deliberateGateEnabled
			? profiles
			: profiles.filter((p) => !isGateReviewRole(p));

	try {
		const { rows } = await queryFn(SQL_ROLES, [
			workflowTemplateId,
			stage.toUpperCase(),
			maturity,
			projectId,
		]);

		if (rows.length > 0) {
			const mapped = rows.map((r) => ({
				id: r.id == null ? null : Number(r.id),
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
			return applyGateFilter(mapped);
		}
	} catch (err) {
		console.warn(
			`[RoleResolver] DB query failed for (wft=${workflowTemplateId}, stage=${stage}, maturity=${maturity}), using BUILTIN_FALLBACK:`,
			err instanceof Error ? err.message : err,
		);
	}

	return applyGateFilter(builtinFallback(stage, maturity));
}

/**
 * AC-3: Alias for getRolesForQueue with alternate parameter naming.
 *
 * Resolves agent role profiles using individual parameters instead of a key object.
 * Provides the named signature required by AC-3.
 *
 * @param workflowTemplateId - Workflow template ID
 * @param stage - Current stage name
 * @param maturity - Current maturity level
 * @param projectId - Optional project ID for tenant-scoped overrides
 * @param queryFn - Injectable query function; defaults to the shared pool
 */
export async function getRolesFor(
	workflowTemplateId: number,
	stage: string,
	maturity: string,
	projectId?: number | null,
	queryFn: QueryFn = defaultQuery,
): Promise<RoleProfile[]> {
	return getRolesForQueue(
		{ workflowTemplateId, stage, maturity, projectId },
		queryFn,
	);
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
