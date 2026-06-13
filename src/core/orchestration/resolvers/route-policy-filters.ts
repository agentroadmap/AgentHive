/**
 * P771/P772/P773: SQL fragment helpers for the 6-layer resolveModelRoute() filter chain.
 * Each function returns a self-contained SQL boolean expression. All are
 * null-safe: passing NULL for the binding parameter skips (open-passes) the layer.
 */

/** P742 Layer 1: host_model_policy allowlist/denylist. */
export function hostPolicyFilterSql(
	hostParamIdx: number,
	alias = "mr",
): string {
	return `(
		EXISTS (
			SELECT 1 FROM roadmap.host_model_policy hp
			 WHERE hp.host_name = $${hostParamIdx}::text
			   AND (
			     coalesce(array_length(hp.allowed_providers, 1), 0) = 0
			     OR ${alias}.route_provider = ANY(hp.allowed_providers)
			   )
			   AND NOT (${alias}.route_provider = ANY(hp.forbidden_providers))
		)
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.host_model_policy hp
			 WHERE hp.host_name = $${hostParamIdx}::text
		)
	)`;
}

/** P771 Layer 2: project_route_policy allowlist/denylist. */
export function projectPolicyFilterSql(
	projectParamIdx: number,
	alias = "mr",
): string {
	return `(
		$${projectParamIdx}::bigint IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.project_route_policy WHERE project_id = $${projectParamIdx}::bigint
		)
		OR EXISTS (
			SELECT 1 FROM roadmap.project_route_policy pp
			WHERE pp.project_id = $${projectParamIdx}::bigint
			  AND (array_length(pp.allowed_route_providers, 1) IS NULL
			       OR ${alias}.route_provider = ANY(pp.allowed_route_providers))
			  AND NOT (${alias}.route_provider = ANY(COALESCE(pp.forbidden_route_providers, '{}')))
		)
	)`;
}

/** P768 Layer 3: agency_route_policy per-route allow/deny (normalized schema).
 *
 * Implements fail-closed semantics: a DENY row (allowed=false) excludes a route.
 * No row or ALLOW row (allowed=true) permits the route.
 * Joins agency.agency by identity, then checks agency_route_policy per-route.
 */
export function agencyPolicyFilterSql(
	agencyParamIdx: number,
	alias = "mr",
): string {
	return `(
		$${agencyParamIdx}::text IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.agency a
			 WHERE a.agency_id = $${agencyParamIdx}::text
		)
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.agency_route_policy arp
			 WHERE arp.agency_id = $${agencyParamIdx}::text
		)
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.agency_route_policy arp
			 WHERE arp.agency_id = $${agencyParamIdx}::text
			   AND arp.route_id = ${alias}.id
			   AND arp.scope = 'global'
			   AND arp.lifecycle_status = 'active'
			   AND arp.allowed = false
		)
		OR EXISTS (
			SELECT 1 FROM roadmap.agency_route_policy arp
			 WHERE arp.agency_id = $${agencyParamIdx}::text
			   AND arp.route_id = ${alias}.id
			   AND arp.scope = 'global'
			   AND arp.lifecycle_status = 'active'
			   AND arp.allowed = true
		)
	)`;
}

/** P771 Layer 4: agent_role_profile route constraints. */
export function rolePolicyFilterSql(
	roleParamIdx: number,
	alias = "mr",
): string {
	return `(
		$${roleParamIdx}::bigint IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.agent_role_profile WHERE id = $${roleParamIdx}::bigint
		)
		OR EXISTS (
			SELECT 1 FROM roadmap.agent_role_profile rp
			WHERE rp.id = $${roleParamIdx}::bigint
			  AND (rp.allowed_route_providers IS NULL
			       OR ${alias}.route_provider = ANY(rp.allowed_route_providers))
			  AND (rp.forbidden_route_providers IS NULL
			       OR NOT (${alias}.route_provider = ANY(rp.forbidden_route_providers)))
		)
	)`;
}

/** P771 Layer 5: exclude routes with exhausted hourly token budgets. */
export function budgetFilterSql(projectParamIdx: number, alias = "mr"): string {
	return `(
		$${projectParamIdx}::bigint IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.route_token_budget rtb
			WHERE rtb.project_id = $${projectParamIdx}::bigint
			  AND rtb.route_provider = ${alias}.route_provider
			  AND rtb.hour_window = date_trunc('hour', NOW())
			  AND rtb.max_tokens IS NOT NULL
			  AND rtb.tokens_consumed >= rtb.max_tokens
		)
	)`;
}

/** P773 Layer 6: exclude routes with an active upstream throttle cooldown.
 *
 * P1376-AC2: Now integrated with proactive throttle via merged view.
 * Checks computed_throttle_until from throttle_until_merged view which
 * merges both agency_capacity.reset_at (proactive) and model_routes.cooldown_until
 * (reactive) using GREATEST.
 */
export function cooldownFilterSql(alias = "mr"): string {
	// P1376-AC2: Use the merged view for unified throttle checking.
	// For now, preserve backward compat with individual column check;
	// resolver integration will move to throttle_until_merged view query.
	return `(${alias}.cooldown_until IS NULL OR ${alias}.cooldown_until <= NOW())`;
}

/** P1435 Layer 6b: exclude routes with provider auth marked as down (401/403 failure).
 * Distinct from cooldown_until (quota exhaustion). Auth-down requires operator
 * intervention to re-establish credentials. */
export function authDownFilterSql(alias = "mr"): string {
	return `(${alias}.auth_down_until IS NULL OR ${alias}.auth_down_until <= NOW())`;
}

/**
 * P772/P773: Diagnostic query that classifies each non-winning enabled route by the
 * first policy layer that eliminated it. Used for the eliminated_routes JSONB in
 * route_decision_log.
 *
 * Param layout (caller must bind in this order):
 *   $providerIdx   — agent_provider TEXT
 *   $winnerIdx     — chosen route id BIGINT (excluded from result)
 *   $hostIdx       — host name TEXT     (Layer 1)
 *   $projectIdx    — project_id BIGINT  (Layers 2 + 5)
 *   $agencyIdx     — agency_identity TEXT (Layer 3)
 *   $roleIdx       — role_profile_id BIGINT (Layer 4)
 *   Layer 6 (cooldown) uses no param — direct column expression.
 */
export function buildEliminationDiagnosticSql(
	providerIdx: number,
	winnerIdx: number,
	hostIdx: number,
	projectIdx: number,
	agencyIdx: number,
	roleIdx: number,
	alias = "mr",
): string {
	return `
		SELECT ${alias}.id, ${alias}.route_provider,
		  CASE
		    WHEN NOT (${hostPolicyFilterSql(hostIdx, alias)}) THEN 'host_policy'
		    WHEN NOT (${projectPolicyFilterSql(projectIdx, alias)}) THEN 'project_policy'
		    WHEN NOT (${agencyPolicyFilterSql(agencyIdx, alias)}) THEN 'agency_policy'
		    WHEN NOT (${rolePolicyFilterSql(roleIdx, alias)}) THEN 'role_policy'
		    WHEN NOT (${budgetFilterSql(projectIdx, alias)}) THEN 'budget_exhausted'
		    WHEN NOT (${cooldownFilterSql(alias)}) THEN 'throttled'
		    ELSE 'passed'
		  END AS first_failing_layer
		FROM roadmap.model_routes ${alias}
		WHERE ${alias}.agent_provider = $${providerIdx} AND ${alias}.is_enabled = true
		  AND ${alias}.id != $${winnerIdx}
	`;
}
