/**
 * Agency Resolver — P761 C1 / P763 C3 / P764 C4
 *
 * Selects the best available agency for a given project + role,
 * respecting the 5-state liveness state machine and in-flight capacity.
 *
 * State machine:
 *   active     → throttled  : spawn failure OR capacity exceeded on check-in
 *   active     → dormant    : silence > 5 min
 *   active     → offline    : silence > 30 min OR operator command
 *   throttled  → active     : next successful check-in
 *   dormant    → active     : check-in received
 *   offline    → active     : operator resume command (not auto)
 *   any        → retired    : operator retire command (terminal)
 */

import { query as _pgQuery } from "../../../infra/postgres/pool.ts";

export const THROTTLE_THRESHOLD = 3; // failures before throttled
export const DORMANT_SILENCE_MINUTES = 5;
export const OFFLINE_SILENCE_MINUTES = 30;

// Allows tests to inject a mock query function without module-level mocking.
type QueryFn = typeof _pgQuery;
let _query: QueryFn = _pgQuery;
export function _setQueryForTest(fn: QueryFn): void {
	_query = fn;
}
function query(...args: Parameters<QueryFn>) {
	return _query(...args);
}

export interface AgencyCandidate {
	id: bigint;
	agencyId: bigint;
	projectId: string | null;
	capabilities: Record<string, unknown>;
	status: string;
	throttleCount: number;
	lastSeenAt: Date | null;
	maxInFlight: number;
	inFlightCount: number;
}

/**
 * Find the best available agency for a project+role.
 * Excludes offline and retired agencies.
 * Filters by in-flight capacity (P764).
 * Ranks by throttle_count ASC, last_seen_at DESC.
 *
 * P1005: Optional taskTier and requiredCapabilities filtering
 * - If taskTier is provided, only agencies with matching tier in capabilities are returned
 * - If requiredCapabilities is provided, agencies must support all listed capabilities
 * - Tier-0 isolation: Tier-3 providers are never matched for Tier-0 requests
 */
/**
 * Permissive-fallback log target. Tests can replace this; production uses console.
 * Kept module-level so the signature of resolveAgency stays unchanged.
 */
let _resolverLogger: Pick<Console, "log" | "warn"> = console;
export function _setResolverLoggerForTest(
	logger: Pick<Console, "log" | "warn">,
): void {
	_resolverLogger = logger;
}

export async function resolveAgency(
	projectId: string,
	_role?: string,
	taskTier?: number,
	requiredCapabilities?: string[],
): Promise<AgencyCandidate | null> {
	// P914: exclude coordinator agents (the orchestrator itself) and
	// test scaffolding identities. Coordinators claim offers and
	// re-dispatch them — they must never be a dispatch target.
	// Belt-and-suspenders against status drift: the resolver checks
	// provider_registry.status, but operators retire via roadmap.agency.status.
	// LEFT JOIN agency lets retired agencies be excluded even if their
	// provider_registry.status hasn't been synced. Legacy registry rows
	// without a matching agency row (a.status IS NULL) continue to qualify.

	// Build WHERE clause dynamically for tier-aware filtering
	let tierFilter = "";
	let capabilityFilter = "";
	const queryParams: (string | number)[] = [projectId];

	// P1005 AC-8: Tier-0 isolation — tier-0 tasks only go to tier-0 providers
	if (taskTier !== undefined) {
		// All tiers except tier-0 can fall back to higher-tier providers
		// For tier-0: exact match required (no fallback to tier-3)
		if (taskTier === 0) {
			// Tier-0 tasks: only providers with explicit tier 0 in capabilities
			// Providers without tier field default to 2, so exclude them too
			tierFilter = ` AND (pr.capabilities->>'tier')::int = 0`;
		} else if (taskTier === 1) {
			// Tier-1: tier-1+ providers (not tier-0)
			tierFilter = ` AND COALESCE((pr.capabilities->>'tier')::int, 2) >= 1`;
		} else if (taskTier === 2) {
			// Tier-2: tier-2+ providers
			tierFilter = ` AND COALESCE((pr.capabilities->>'tier')::int, 2) >= 2`;
		} else if (taskTier === 3) {
			// Tier-3: only tier-3 providers
			tierFilter = ` AND COALESCE((pr.capabilities->>'tier')::int, 2) >= 3`;
		}
	}

	// P1005: Filter by required capabilities
	if (requiredCapabilities && requiredCapabilities.length > 0) {
		// Build JSON contains check for each required capability
		capabilityFilter = requiredCapabilities
			.map((cap, idx) => {
				queryParams.push(cap);
				return `pr.capabilities->'jobs' ? $${queryParams.length}`;
			})
			.join(" AND ");
		if (capabilityFilter) {
			capabilityFilter = ` AND (${capabilityFilter})`;
		}
	}

	const baseSelect = `SELECT pr.id, pr.agency_id, pr.project_id, pr.capabilities,
		        pr.status, pr.throttle_count, pr.last_seen_at, pr.max_in_flight,
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count
		 FROM roadmap_workforce.provider_registry pr
		 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
		 LEFT JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
		 -- AC-3: agencies with a roadmap.agency row must have an active liaison session
		 -- (status='active' AND last_heartbeat_at within 90 s). Agencies with no
		 -- roadmap.agency row (legacy) pass through for backward compatibility.
		 LEFT JOIN roadmap.v_agency_status vas ON vas.agency_id = ar.agent_identity
		 LEFT JOIN roadmap_workforce.v_agency_in_flight inf
		   ON inf.provider_registry_id = pr.id
		 WHERE pr.status NOT IN ('offline', 'retired')
		   AND (a.status IS NULL OR a.status <> 'retired')
		   AND (vas.agency_id IS NULL OR vas.dispatchable = true)
		   AND ar.agent_type <> 'coordinator'
		   AND ar.agent_identity NOT LIKE 'test/%'
		   AND (pr.project_id IS NULL OR pr.project_id = $1)
		   AND COALESCE(inf.in_flight_count, 0) < pr.max_in_flight
		   ${tierFilter}`;
	const orderAndLimit = ` ORDER BY (vas.dispatchable IS TRUE) DESC,
		          pr.throttle_count ASC,
		          COALESCE(inf.in_flight_count, 0) ASC,
		          pr.last_seen_at DESC NULLS LAST,
		          RANDOM()
		 LIMIT 1`;

	const { rows } = await query(
		baseSelect + capabilityFilter + orderAndLimit,
		queryParams,
	);

	// Permissive fallback: when the strict capability filter rejects every
	// agency (e.g. provider_registry.capabilities.jobs hasn't been seeded),
	// retry without the capability filter so dispatch keeps flowing rather
	// than expiring offers in a loop. Logs a warn for ops visibility — a
	// healthy system should always have at least one capability-matched
	// agency, so this firing means data drift to investigate.
	let resultRows = rows;
	let usedFallback = false;
	if (
		!resultRows.length &&
		requiredCapabilities &&
		requiredCapabilities.length > 0
	) {
		// Re-run without the capability filter. The cap-only params are at
		// indices > 1 (projectId is $1), so trimming queryParams to [projectId]
		// is enough — the rebuilt SQL omits $2..$N entirely.
		const fallback = await query(
			baseSelect + orderAndLimit,
			[projectId],
		);
		if (fallback.rows.length > 0) {
			usedFallback = true;
			resultRows = fallback.rows;
			_resolverLogger.warn(
				`[agency-resolver] permissive fallback fired: no agency had jobs ${JSON.stringify(requiredCapabilities)}; matched without filter. Seed provider_registry.capabilities.jobs to remove this warning.`,
			);
		}
	}

	if (!resultRows.length) return null;

	const row = resultRows[0];
	return {
		id: BigInt(row.id),
		agencyId: BigInt(row.agency_id),
		projectId: row.project_id,
		capabilities: usedFallback
			? { ...(row.capabilities ?? {}), _resolved_via: "permissive-fallback" }
			: row.capabilities,
		status: row.status,
		throttleCount: row.throttle_count,
		lastSeenAt: row.last_seen_at,
		maxInFlight: row.max_in_flight,
		inFlightCount: Number(row.in_flight_count),
	};
}

/**
 * Record a spawn failure for an agency (P761 + P763).
 * Increments throttle_count and recent_failure_count; transitions to
 * 'throttled' when the threshold is exceeded.
 * Called by agent-spawner on spawn failure.
 *
 * @param agencyRegistryId — agent_registry.id (BIGINT) for the agency row
 */
export async function recordSpawnFailure(
	agencyRegistryId: bigint,
): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.provider_registry
		 SET throttle_count        = throttle_count + 1,
		     recent_failure_count  = recent_failure_count + 1,
		     last_failure_at       = now(),
		     status = CASE
		       WHEN throttle_count + 1 >= $2 AND status = 'active' THEN 'throttled'
		       ELSE status
		     END,
		     status_reason = CASE
		       WHEN throttle_count + 1 >= $2 THEN 'Spawn failure threshold exceeded'
		       ELSE status_reason
		     END,
		     updated_at = now()
		 WHERE agency_id = $1`,
		[agencyRegistryId, THROTTLE_THRESHOLD],
	);
}

/**
 * Record a successful check-in for an agency (P761 + P763).
 * Updates last_seen_at in provider_registry; resets status to active from
 * throttled/dormant; decays recent_failure_count on successful check-in.
 * Called by liaison-service on heartbeat.
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function recordCheckIn(agencyIdentity: string): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET last_seen_at          = now(),
		     status = CASE
		       WHEN pr.status IN ('throttled', 'dormant') THEN 'active'
		       ELSE pr.status
		     END,
		     throttle_count = CASE
		       WHEN pr.status = 'throttled' THEN 0
		       ELSE pr.throttle_count
		     END,
		     recent_failure_count = CASE
		       WHEN pr.status = 'throttled' THEN 0
		       ELSE GREATEST(0, pr.recent_failure_count - 1)
		     END,
		     last_failure_at = CASE
		       WHEN pr.status = 'throttled' THEN NULL
		       ELSE pr.last_failure_at
		     END,
		     status_reason = CASE
		       WHEN pr.status IN ('throttled', 'dormant') THEN 'Recovered on check-in'
		       ELSE pr.status_reason
		     END,
		     updated_at = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status NOT IN ('offline', 'retired')`,
		[agencyIdentity],
	);
}

/**
 * Scan for agencies that have gone silent and transition them to dormant/offline.
 * Called periodically by the orchestrator scanner.
 */
export async function scanAndTransitionSilentAgencies(): Promise<void> {
	// dormant/offline after 30 min total silence (checked first to avoid
	// re-updating rows that already match the 5-min dormant window)
	await query(
		`UPDATE roadmap_workforce.provider_registry
		 SET status        = 'offline',
		     status_reason = 'No check-in > 30 min',
		     updated_at    = now()
		 WHERE status IN ('active', 'dormant')
		   AND last_seen_at IS NOT NULL
		   AND now() - last_seen_at > interval '30 minutes'`,
	);

	// active → dormant after 5 min silence
	await query(
		`UPDATE roadmap_workforce.provider_registry
		 SET status        = 'dormant',
		     status_reason = 'No check-in > 5 min',
		     updated_at    = now()
		 WHERE status = 'active'
		   AND last_seen_at IS NOT NULL
		   AND now() - last_seen_at > interval '5 minutes'`,
	);
}
