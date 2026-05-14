/**
 * Agency Resolver — P761 C1 / P763 C3 / P764 C4 / P765 C5
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
 *   offline    → dormant    : check-in received (auto-recovery, P765 AC-1)
 *   offline    → active     : operator resume_liaison command (P765 AC-2)
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
 */
export async function resolveAgency(
	projectId: string,
	_role?: string,
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
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count
		 FROM roadmap_workforce.provider_registry pr
		 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
		 LEFT JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
		 LEFT JOIN roadmap_workforce.v_agency_in_flight inf
		   ON inf.provider_registry_id = pr.id
		 WHERE pr.status NOT IN ('offline', 'retired')
		   AND (a.status IS NULL OR a.status <> 'retired')
		   AND ar.agent_type <> 'coordinator'
		   AND ar.agent_identity NOT LIKE 'test/%'
		   AND (pr.project_id IS NULL OR pr.project_id = $1)
		   AND COALESCE(inf.in_flight_count, 0) < pr.max_in_flight
		 ORDER BY pr.throttle_count ASC, pr.last_seen_at DESC NULLS LAST
		 LIMIT 1`,
		[projectId],
	);

	if (!rows.length) return null;

	const row = rows[0];
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
 * Record a successful check-in for an agency (P761 + P763 + P765).
 * Updates last_seen_at in provider_registry; resets status to active from
 * throttled/dormant; transitions offline → dormant (AC-1 auto-recovery);
 * decays recent_failure_count on successful check-in.
 * Called by liaison-service on heartbeat.
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function recordCheckIn(agencyIdentity: string): Promise<void> {
	const { rows } = await query<{
		old_status: string;
		new_status: string;
		had_alert: boolean;
	}>(
		`WITH before AS (
		   SELECT pr.id,
		          pr.status                            AS old_status,
		          pr.offline_alerted_at IS NOT NULL    AS had_alert
		   FROM roadmap_workforce.provider_registry pr
		   JOIN roadmap_workforce.agent_registry ar ON pr.agency_id = ar.id
		   WHERE ar.agent_identity = $1
		     AND pr.status NOT IN ('retired')
		 ),
		 updated AS (
		   UPDATE roadmap_workforce.provider_registry pr
		   SET last_seen_at         = now(),
		       status = CASE
		         WHEN pr.status = 'offline'              THEN 'dormant'
		         WHEN pr.status IN ('throttled','dormant') THEN 'active'
		         ELSE pr.status
		       END,
		       throttle_count = CASE
		         WHEN pr.status IN ('throttled','offline') THEN 0
		         ELSE pr.throttle_count
		       END,
		       recent_failure_count = CASE
		         WHEN pr.status IN ('throttled','offline') THEN 0
		         ELSE GREATEST(0, pr.recent_failure_count - 1)
		       END,
		       last_failure_at = CASE
		         WHEN pr.status IN ('throttled','offline') THEN NULL
		         ELSE pr.last_failure_at
		       END,
		       offline_since_at = CASE
		         WHEN pr.status = 'offline' THEN NULL
		         ELSE pr.offline_since_at
		       END,
		       offline_alerted_at = CASE
		         WHEN pr.status = 'offline' THEN NULL
		         ELSE pr.offline_alerted_at
		       END,
		       status_reason = CASE
		         WHEN pr.status IN ('throttled','dormant','offline') THEN 'Recovered on check-in'
		         ELSE pr.status_reason
		       END,
		       updated_at = now()
		   FROM before b
		   WHERE pr.id = b.id
		   RETURNING pr.status AS new_status, b.old_status, b.had_alert
		 )
		 SELECT old_status, new_status, had_alert FROM updated`,
		[agencyIdentity],
	);

	for (const row of rows) {
		if (row.old_status === "offline" && row.new_status === "dormant") {
			// AC-4: resolved alert when recovering from a previously-alerted offline episode
			if (row.had_alert) {
				await query(`SELECT pg_notify('discord_send', $1::text)`, [
					JSON.stringify({
						from: "agency-liveness-scanner",
						message: `Agency ${agencyIdentity} recovered from offline — heartbeat resumed. Dispatch capacity restored.`,
						level: "success",
						ts: new Date().toISOString(),
					}),
				]);
			}
			// AC-1: wake orchestrator so it can fill queued offers with this newly-available agency
			await query(
				`SELECT pg_notify('work_offers', '{"source":"agency_recovery"}')`,
				[],
			);
		}
	}
}

/**
 * Operator short-circuit: force agency provider status to 'active' from any
 * non-retired state (P765 AC-2). Bypasses the heartbeat-based recovery path
 * so operators can unblock a stuck-offline agency without waiting for a
 * liaison restart.
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function resumeAgencyProviderLiaison(
	agencyIdentity: string,
): Promise<void> {
	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET status             = 'active',
		     status_reason      = 'Operator resume_liaison command',
		     offline_since_at   = NULL,
		     offline_alerted_at = NULL,
		     throttle_count     = 0,
		     recent_failure_count = 0,
		     last_failure_at    = NULL,
		     updated_at         = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status <> 'retired'`,
		[agencyIdentity],
	);

	// Wake orchestrator to fill queued offers immediately
	await query(
		`SELECT pg_notify('work_offers', '{"source":"operator_resume_liaison"}')`,
		[],
	);
}

/**
 * Emit Discord offline alerts for agencies that have been offline > 10 min
 * with no alert sent yet (AC-3/AC-4 single-shot alerting).
 * Called from scanAndTransitionSilentAgencies() after transitioning to offline.
 */
async function emitOfflineAlerts(): Promise<void> {
	const { rows } = await query<{ id: string; agent_identity: string }>(
		`WITH alerted AS (
		   UPDATE roadmap_workforce.provider_registry pr
		   SET offline_alerted_at = now(),
		       updated_at         = now()
		   WHERE pr.status = 'offline'
		     AND pr.offline_since_at IS NOT NULL
		     AND pr.offline_alerted_at IS NULL
		     AND now() - pr.offline_since_at > interval '10 minutes'
		   RETURNING pr.id, pr.agency_id
		 )
		 SELECT al.id::text, ar.agent_identity
		 FROM alerted al
		 JOIN roadmap_workforce.agent_registry ar ON ar.id = al.agency_id`,
		[],
	);

	for (const row of rows) {
		await query(`SELECT pg_notify('discord_send', $1::text)`, [
			JSON.stringify({
				from: "agency-liveness-scanner",
				message: `Agency ${row.agent_identity} (registry id: ${row.id}) has been offline for >10 minutes. Check liaison heartbeat.`,
				level: "warning",
				ts: new Date().toISOString(),
			}),
		]);
	}
}

/**
 * Scan for agencies that have gone silent and transition them to dormant/offline.
 * Called periodically by the orchestrator scanner (P765 AC-5).
 */
export async function scanAndTransitionSilentAgencies(): Promise<void> {
	// active/dormant → offline after 30 min total silence (checked first to
	// avoid re-updating rows that already match the 5-min dormant window)
	await query(
		`UPDATE roadmap_workforce.provider_registry
		 SET status           = 'offline',
		     status_reason    = 'No check-in > 30 min',
		     offline_since_at = now(),
		     updated_at       = now()
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

	// AC-3/AC-4: emit Discord alerts for newly-qualifying offline agencies
	await emitOfflineAlerts();
}
