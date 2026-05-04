/**
 * P771: SQL fragment helpers for the 5-layer resolveModelRoute() filter chain.
 * Each function returns a self-contained SQL boolean expression. All are
 * null-safe: passing NULL for the binding parameter skips (open-passes) the layer.
 */

/** P771 Layer 2: project_route_policy allowlist/denylist. */
export function projectPolicyFilterSql(projectParamIdx: number, alias = "mr"): string {
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

/** P771 Layer 3: agency_route_policy allowlist/denylist. */
export function agencyPolicyFilterSql(agencyParamIdx: number, alias = "mr"): string {
	return `(
		$${agencyParamIdx}::text IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM roadmap.agency_route_policy WHERE agency_identity = $${agencyParamIdx}::text
		)
		OR EXISTS (
			SELECT 1 FROM roadmap.agency_route_policy arp
			WHERE arp.agency_identity = $${agencyParamIdx}::text
			  AND (array_length(arp.allowed_route_providers, 1) IS NULL
			       OR ${alias}.route_provider = ANY(arp.allowed_route_providers))
			  AND NOT (${alias}.route_provider = ANY(COALESCE(arp.forbidden_route_providers, '{}')))
		)
	)`;
}

/** P771 Layer 4: agent_role_profile route constraints. */
export function rolePolicyFilterSql(roleParamIdx: number, alias = "mr"): string {
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
