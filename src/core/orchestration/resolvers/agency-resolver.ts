/**
 * Agency Resolver — P761 C1 / P763 C3 / P764 C4 / P765 C5
 *
 * Selects the best available agency for a given project + role,
 * respecting the 5-state liveness state machine and in-flight capacity.
 *
 * State machine:
 *   active     → throttled  : spawn failure OR capacity exceeded on check-in
 *   active     → dormant    : silence > 5 min
 *   dormant    → offline    : silence > 30 min (provider_registry) / 5 min (roadmap.agency P765)
 *   throttled  → active     : next successful check-in
 *   dormant    → active     : check-in received
 *   offline    → dormant    : first check-in received after silence (P765 AC-1 auto-recovery step 1)
 *   dormant    → active     : second check-in received after offline (P765 AC-1 auto-recovery step 2)
 *   offline    → active     : operator resume command (AC-2 short-circuit)
 *   any        → retired    : operator retire command (terminal)
 */

import { query as _pgQuery } from "../../../infra/postgres/pool.ts";
import { enqueueNotification } from "../../notifications/enqueue.ts";

export const THROTTLE_THRESHOLD = 3; // failures before throttled
export const DORMANT_SILENCE_MINUTES = 5;
export const OFFLINE_SILENCE_MINUTES = 30;
export const OFFLINE_ALERT_THRESHOLD_MINUTES = 10;

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
	/** P1351 AC-6: agency chain for nested agencies [parent_id, ..., leaf_id] */
	agencyChain?: string[];
}

/**
 * P1351 AC-6: Build the agency chain from leaf to root by walking parent_agency_id.
 * Returns [parent_id, ..., leaf_id] for nested agencies, or [agency_id] for root agencies.
 */
export async function buildAgencyChain(agencyId: string): Promise<string[]> {
	const chain: string[] = [];
	let currentId: string | null = agencyId;

	// Walk up the parent chain (max 100 levels to prevent infinite loops)
	for (let depth = 0; depth < 100 && currentId; depth++) {
		const { rows } = await query<{
			agency_id: string;
			parent_agency_id: string | null;
		}>(
			`SELECT agency_id, parent_agency_id FROM roadmap.agency WHERE agency_id = $1`,
			[currentId],
		);

		if (!rows.length) break;

		const row = rows[0];
		chain.unshift(row.agency_id); // prepend to build top-down order

		if (!row.parent_agency_id) break; // reached root
		currentId = row.parent_agency_id;
	}

	return chain.length > 0 ? chain : [agencyId];
}

/**
 * Find the best available agency for a project+role.
 * Excludes offline and retired agencies.
 * Filters by in-flight capacity (P764).
 * Ranks by throttle_count ASC, last_seen_at DESC.
 *
 * V3-C8 (P1440): Supports capability matching — filters agencies by required_capabilities.
 * If requiredCapabilities is provided, only returns agencies whose capabilities
 * are a SUPERSET of the required set. On no match, emits an escalation with evidence.
 *
 * P1351 AC-6: Includes agency_chain (parent..leaf) in the returned candidate.
 *
 * TODO P1365-AC4/AC8: Integrate capacity filtering
 * - LEFT JOIN roadmap_workforce.agency_capacity on (provider, model, agency_id)
 * - WHERE throttle_action != 'hard' (hard-throttled agencies excluded)
 * - Tiebreaker: add COALESCE(1 - p_skip, 1.0) DESC to the ORDER BY
 *   (soft-throttled agencies ranked lower than healthy ones)
 * - Log throttle decision to message_ledger when soft/hard action is applied
 *   (see ../capacity-filter.ts::logThrottleDecision)
 */
export async function resolveAgency(
	projectId: string,
	_role?: string,
	requiredCapabilities?: unknown,
): Promise<AgencyCandidate | null> {
	// P914: exclude coordinator agents (the orchestrator itself) and
	// test scaffolding identities. Coordinators claim offers and
	// re-dispatch them — they must never be a dispatch target.
	// Belt-and-suspenders against status drift: the resolver checks
	// provider_registry.status, but operators retire via roadmap.agency.status.
	// LEFT JOIN agency lets retired agencies be excluded even if their
	// provider_registry.status hasn't been synced. Legacy registry rows
	// without a matching agency row (a.status IS NULL) continue to qualify.
	const { rows } = await query(
		`SELECT pr.id, pr.agency_id, pr.project_id, pr.capabilities,
		        pr.status, pr.throttle_count, pr.last_seen_at, pr.max_in_flight,
		        pr.agency_identity,
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count
		 FROM roadmap_workforce.provider_registry pr
		 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
		 LEFT JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
		 LEFT JOIN roadmap_workforce.v_agency_in_flight inf
		   ON inf.provider_registry_id = pr.id
		 WHERE pr.status NOT IN ('offline', 'retired')
		   AND (a.status IS NULL OR a.status <> 'retired')
		   AND ar.agent_type <> 'coordinator'
		   -- P1456 AC-2: interactive CLI session instances are addressable
		   -- (A2A) but NOT dispatchable. Exclude them from candidate selection.
		   AND ar.role IS DISTINCT FROM 'interactive-session'
		   AND ar.agent_identity NOT LIKE 'test/%'
		   AND (pr.project_id IS NULL OR pr.project_id = $1)
		   AND COALESCE(inf.in_flight_count, 0) < pr.max_in_flight
		 ORDER BY pr.throttle_count ASC, pr.last_seen_at DESC NULLS LAST
		 LIMIT 1`,
		[projectId],
	);

	if (!rows.length) return null;

	const row = rows[0];

	// V3-C8 (P1440): Apply capability subset matching if required_capabilities are specified.
	if (requiredCapabilities) {
		const {
			isCapabilitySubsetMatch,
			describeMissingCapabilities,
		} = await import("../capability-taxonomy.ts");

		if (!isCapabilitySubsetMatch(row.capabilities, requiredCapabilities)) {
			// Log escalation for operator visibility
			const reason = describeMissingCapabilities(
				row.capabilities,
				requiredCapabilities,
			);
			try {
				await query(
					`INSERT INTO roadmap.escalation_log
					 (obstacle_type, agent_identity, escalated_to, severity, resolution_note)
					 VALUES ('CAPABILITY_MISMATCH', $1, 'orchestrator', 'medium', $2)`,
					[row.agency_identity, reason],
				);
			} catch (err) {
				// Non-blocking: escalation log failure does not block dispatch
				console.warn(
					`[agency-resolver] Failed to write CAPABILITY_MISMATCH escalation:`,
					err,
				);
			}
			// Agency does not meet capability requirements
			return null;
		}
	}

	// P1375 (P1365-C AC-8 follow-up): capacity-aware throttle audit.
	// Score the selected candidate against agency_capacity ('*' = provider-level
	// wildcard row written by the P1859 probe bridge). Hard-throttled candidates
	// are rejected; soft/hard decisions are audit-logged fire-and-forget — a
	// logging failure must never block resolution (AC-3). Fail-open on errors.
	try {
		const { computeCapacityScoreMultiplier, logThrottleDecision } = await import(
			"../capacity-filter.ts"
		);
		const provider =
			typeof (row.capabilities as Record<string, unknown>)?.provider === "string"
				? ((row.capabilities as Record<string, unknown>).provider as string)
				: "*";
		const { multiplier, score } = await computeCapacityScoreMultiplier(
			row.agency_identity,
			provider,
			"*",
		);
		if (score.action === "soft" || score.action === "hard") {
			void logThrottleDecision(
				row.agency_identity,
				provider,
				"*",
				score,
				row.project_id != null ? String(row.project_id) : projectId,
			);
		}
		if (multiplier === 0) {
			// Hard-throttled: never dispatch to this agency.
			return null;
		}
	} catch (err) {
		console.warn(
			`[agency-resolver] capacity check failed for ${row.agency_identity} (fail-open):`,
			err instanceof Error ? err.message : err,
		);
	}

	// P1351 AC-6: build agency chain for nested agencies
	const agencyChain = await buildAgencyChain(row.agency_identity);

	return {
		id: BigInt(row.id),
		agencyId: BigInt(row.agency_id),
		projectId: row.project_id,
		capabilities: row.capabilities,
		status: row.status,
		throttleCount: row.throttle_count,
		lastSeenAt: row.last_seen_at,
		maxInFlight: row.max_in_flight,
		inFlightCount: Number(row.in_flight_count),
		agencyChain,
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
 * P1360 Change 1: Increment spawn failure counters by agency string identity.
 * Resolves the provider_registry row via agent_registry.agent_identity, then
 * bumps throttle_count/recent_failure_count and transitions to 'throttled'
 * once the threshold is crossed.
 *
 * Used by OfferDispatchHandler which knows the string identity, not the bigint PK.
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT (e.g. "ccs46ant-bot-dev-a")
 * @param threshold — failure count before 'throttled'; defaults to THROTTLE_THRESHOLD
 * @param errorClass — structured error class for status_reason signal
 */
export async function incrementSpawnFailure(
	agencyIdentity: string,
	threshold: number = THROTTLE_THRESHOLD,
	errorClass: "auth" | "spawn" | "timeout" | "unknown" = "unknown",
): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET throttle_count        = throttle_count + 1,
		     recent_failure_count  = recent_failure_count + 1,
		     last_failure_at       = now(),
		     status = CASE
		       WHEN throttle_count + 1 >= $2 AND pr.status = 'active' THEN 'throttled'
		       ELSE pr.status
		     END,
		     status_reason = CASE
		       WHEN throttle_count + 1 >= $2
		         THEN $3
		       ELSE pr.status_reason
		     END,
		     updated_at = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status NOT IN ('retired')`,
		[agencyIdentity, threshold, `Spawn failure threshold exceeded (${errorClass})`],
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
		// P765 AC-1: offline → dormant on first check-in (two-step recovery).
		// Previously excluded 'offline'; now allows it but only steps to 'dormant',
		// not directly to 'active'. The second check-in (dormant → active) is handled
		// by the existing WHEN dormant THEN active branch.
		`UPDATE roadmap_workforce.provider_registry pr
		 SET last_seen_at          = now(),
		     status = CASE
		       WHEN pr.status = 'offline'                THEN 'dormant'
		       WHEN pr.status IN ('throttled', 'dormant') THEN 'active'
		       WHEN pr.status = 'offline'                 THEN 'dormant'  -- P765 AC-1: step 1 of auto-recovery
		       ELSE pr.status
		     END,
		     throttle_count = CASE
		       WHEN pr.status IN ('throttled', 'offline') THEN 0
		       ELSE pr.throttle_count
		     END,
		     recent_failure_count = CASE
		       WHEN pr.status IN ('throttled', 'offline') THEN 0
		       ELSE GREATEST(0, pr.recent_failure_count - 1)
		     END,
		     last_failure_at = CASE
		       WHEN pr.status IN ('throttled', 'offline') THEN NULL
		       ELSE pr.last_failure_at
		     END,
		     status_reason = CASE
		       WHEN pr.status = 'offline'               THEN 'Recovering: offline→dormant'
		       WHEN pr.status IN ('throttled', 'dormant') THEN 'Recovered on check-in'
		       WHEN pr.status = 'offline'                 THEN 'Auto-recovery started: first check-in'
		       ELSE pr.status_reason
		     END,
		     updated_at = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status NOT IN ('retired')`,
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

/**
 * Operator short-circuit: force an agency to 'active' from any non-retired state
 * via an operator_resume signal (P765 AC-2).
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function resumeAgency(agencyIdentity: string): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET status        = 'active',
		     status_reason = 'Operator resume',
		     throttle_count        = 0,
		     recent_failure_count  = 0,
		     last_failure_at       = NULL,
		     updated_at            = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status NOT IN ('retired')`,
		[agencyIdentity],
	);
}

export interface OfflineAlertRow {
	agencyId: string;
	displayName: string;
	provider: string;
	hostId: string;
	offlineMinutes: number;
	projectId: string | null;
	isRecovered: boolean;
}

/**
 * Operator action: pause an agency (P766 AC-2).
 *
 * State transition: roadmap.agency.status → 'paused'
 * Audit: records to operator_audit_log
 * Effect: agency is unavailable for dispatch while paused, but liaison may still run
 * Reversible via resumeAgencyOperator
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 * @param operator — operator name for audit trail
 * @param reason — optional reason for audit trail
 */
export async function pauseAgencyOperator(
	agencyIdentity: string,
	operator: string,
	reason?: string,
): Promise<void> {
	await query(
		`UPDATE roadmap.agency
		 SET status        = 'paused',
		     status_reason = $2
		 WHERE agency_id = $1`,
		[agencyIdentity, reason ?? 'Operator pause'],
	);

	// Audit log
	await query(
		`INSERT INTO roadmap.operator_audit_log
		 (operator_name, action, decision, target_kind, target_identity, request_summary)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			operator,
			'liaison_pause',
			'allow',
			'agency',
			agencyIdentity,
			JSON.stringify({ reason: reason ?? 'Operator pause' }),
		],
	);
}

/**
 * Operator action: resume a paused agency (P766 AC-2).
 *
 * State transition: roadmap.agency.status='paused' → 'active'
 * Audit: records to operator_audit_log
 * Effect: agency becomes available for dispatch again
 * Reverses pauseAgencyOperator
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 * @param operator — operator name for audit trail
 * @param reason — optional reason for audit trail
 */
export async function resumeAgencyOperator(
	agencyIdentity: string,
	operator: string,
	reason?: string,
): Promise<void> {
	await query(
		`UPDATE roadmap.agency
		 SET status        = 'active',
		     status_reason = $2
		 WHERE agency_id = $1`,
		[agencyIdentity, reason ?? 'Operator resume'],
	);

	// Audit log
	await query(
		`INSERT INTO roadmap.operator_audit_log
		 (operator_name, action, decision, target_kind, target_identity, request_summary)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			operator,
			'liaison_resume',
			'allow',
			'agency',
			agencyIdentity,
			JSON.stringify({ reason: reason ?? 'Operator resume' }),
		],
	);
}

/**
 * Operator action: retire an agency (P766 AC-2).
 *
 * State transition: any → 'retired' (terminal)
 * Audit: records to operator_audit_log
 * Effect: agency is permanently removed from dispatch eligibility
 * Not reversible
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 * @param operator — operator name for audit trail
 * @param reason — optional reason for audit trail
 */
export async function retireAgencyOperator(
	agencyIdentity: string,
	operator: string,
	reason?: string,
): Promise<void> {
	await query(
		`UPDATE roadmap.agency
		 SET status        = 'retired',
		     status_reason = $2
		 WHERE agency_id = $1`,
		[agencyIdentity, reason ?? 'Operator retire'],
	);

	// Audit log
	await query(
		`INSERT INTO roadmap.operator_audit_log
		 (operator_name, action, decision, target_kind, target_identity, request_summary)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[
			operator,
			'agency_retire',
			'allow',
			'agency',
			agencyIdentity,
			JSON.stringify({ reason: reason ?? 'Operator retire' }),
		],
	);
}

/**
 * Scan for offline-alert conditions and emit notifications (P765 AC-3/AC-4).
 *
 * Two cases are handled per call:
 *   1. New offline episodes: status='offline', threshold exceeded, alert_sent_at IS NULL
 *      → emit agency_offline notification, set offline_alert_sent_at = now()
 *   2. Resolved episodes: status≠'offline', offline_alert_sent_at IS NOT NULL
 *      → emit agency_offline_resolved notification, clear offline_alert_sent_at
 *
 * Alert deduplication (AC-4): offline_alert_sent_at prevents repeated alerts
 * within a single offline episode. Cleared on recovery so the next episode
 * gets a fresh alert.
 */
export async function scanAndAlertOfflineAgencies(
	thresholdMinutes = OFFLINE_ALERT_THRESHOLD_MINUTES,
): Promise<void> {
	// Case 1: agencies that need a new offline alert
	const { rows: newOffline } = await query<{
		agency_id: string;
		display_name: string;
		provider: string;
		host_id: string;
		offline_minutes: number;
		project_id: string | null;
	}>(
		`SELECT a.agency_id, a.display_name, a.provider, a.host_id,
		        EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) / 60 AS offline_minutes,
		        pr.project_id
		 FROM roadmap.agency a
		 LEFT JOIN roadmap_workforce.agent_registry ar ON ar.agent_identity = a.agency_id
		 LEFT JOIN roadmap_workforce.provider_registry pr ON pr.agency_id = ar.id
		 WHERE a.status = 'offline'
		   AND a.last_heartbeat_at IS NOT NULL
		   AND now() - a.last_heartbeat_at > make_interval(mins => $1)
		   AND a.offline_alert_sent_at IS NULL
		 ORDER BY a.last_heartbeat_at ASC`,
		[thresholdMinutes],
	);

	for (const row of newOffline) {
		const mins = Math.round(row.offline_minutes);
		const scope = row.project_id ? `project ${row.project_id}` : "platform";
		await enqueueNotification({
			severity: "HIGH",
			kind: "agency_offline",
			title: `Agency offline: ${row.display_name}`,
			body: `Agency ${row.agency_id} (${row.provider}/${row.host_id}) has been offline for ${mins} minutes. Scope: ${scope}.`,
			payload: {
				agencyId: row.agency_id,
				displayName: row.display_name,
				provider: row.provider,
				hostId: row.host_id,
				offlineMinutes: mins,
				projectId: row.project_id,
			},
		});

		// Mark alert as sent for this offline episode
		await query(
			`UPDATE roadmap.agency
			 SET offline_alert_sent_at = now()
			 WHERE agency_id = $1 AND status = 'offline'`,
			[row.agency_id],
		);
	}

	// Case 2: agencies that recovered — alert_sent_at still set but no longer offline
	const { rows: recovered } = await query<{
		agency_id: string;
		display_name: string;
		provider: string;
		status: string;
	}>(
		`SELECT agency_id, display_name, provider, status
		 FROM roadmap.agency
		 WHERE status NOT IN ('offline', 'retired')
		   AND offline_alert_sent_at IS NOT NULL`,
	);

	for (const row of recovered) {
		await enqueueNotification({
			severity: "INFO",
			kind: "agency_offline_resolved",
			title: `Agency recovered: ${row.display_name}`,
			body: `Agency ${row.agency_id} (${row.provider}) has recovered. Current status: ${row.status}.`,
			payload: {
				agencyId: row.agency_id,
				displayName: row.display_name,
				provider: row.provider,
				recoveredStatus: row.status,
			},
		});

		// Clear episode flag so the next offline episode gets a fresh alert
		await query(
			`UPDATE roadmap.agency
			 SET offline_alert_sent_at = NULL
			 WHERE agency_id = $1`,
			[row.agency_id],
		);
	}
}
