/**
 * P771: Types for the 5-layer resolveModelRoute() filter chain.
 */

/** Which policy layer eliminated a candidate route. */
export type EliminationReason =
	| "host_policy"
	| "project_policy"
	| "agency_policy"
	| "role_policy"
	| "budget_exhausted";

/** A route candidate that was excluded before selection. */
export interface EliminatedRoute {
	routeProvider: string;
	reason: EliminationReason;
}

/** Input options for the 5-layer route resolver. */
export interface ResolveRouteOpts {
	provider: string;
	/** P771 Layer 2: project_route_policy lookup key. Skip layer when null. */
	projectId?: number | null;
	/** P771 Layer 3: agency_route_policy lookup key. Skip layer when null. */
	agencyIdentity?: string | null;
	/** P771 Layer 4: agent_role_profile row id. Skip layer when null. */
	roleProfileId?: number | null;
	/** Optional model hint (takes precedence over default selection). */
	modelHint?: string | null;
}
