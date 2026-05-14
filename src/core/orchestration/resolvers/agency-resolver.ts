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
 *   offline    → dormant    : first check-in after offline (AC-1, P765)
 *   dormant    → active     : following check-in after offline recovery
 *   offline    → active     : operatorResumeAgency() (AC-2, P765)
 *   any        → retired    : operator retire command (terminal)
 */

import { query as _pgQuery } from "../../../infra/postgres/pool.ts";
import {
	discordSend as _discordSendImpl,
	type DiscordLevel,
} from "../../../infra/discord/notify.ts";

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

// Allows tests to inject a mock discord sender.
type DiscordSendFn = (
	from: string,
	message: string,
	level?: DiscordLevel,
) => Promise<void>;
let _discordSend: DiscordSendFn = _discordSendImpl;
export function _setDiscordForTest(fn: DiscordSendFn): void {
	_discordSend = fn;
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
	const { rows } = await query(
		`SELECT pr.id, pr.agency_id, pr.project_id, pr.capabilities,
		        pr.status, pr.throttle_count, pr.last_seen_at, pr.max_in_flight,
		        COALESCE(inf.in_flight_count, 0) AS in_flight_count
		 FROM roadmap_workforce.provider_registry pr
		 LEFT JOIN roadmap_workforce.v_agency_in_flight inf
		   ON inf.provider_registry_id = pr.id
		 WHERE pr.status NOT IN ('offline', 'retired')
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
 * Record a successful check-in for an agency (P761 + P763 + P765-AC1).
 *
 * Transition table:
 *   offline   → dormant  : first heartbeat after going offline (AC-1)
 *   dormant   → active   : heartbeat after dormant; if alert was sent, fires recovery Discord
 *   throttled → active   : heartbeat resets throttle counters
 *   active    → active   : last_seen_at bump only
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function recordCheckIn(agencyIdentity: string): Promise<void> {
	const result = await query(
		`WITH old_state AS (
		   SELECT pr.id, pr.status AS old_status,
		          pr.alert_sent_at AS old_alert_sent_at,
		          pr.project_id
		   FROM roadmap_workforce.provider_registry pr
		   JOIN roadmap_workforce.agent_registry ar ON pr.agency_id = ar.id
		   WHERE ar.agent_identity = $1
		     AND pr.status NOT IN ('retired')
		 ),
		 updated AS (
		   UPDATE roadmap_workforce.provider_registry pr
		   SET last_seen_at         = now(),
		       status = CASE
		         WHEN os.old_status = 'offline'                  THEN 'dormant'
		         WHEN os.old_status IN ('throttled', 'dormant')  THEN 'active'
		         ELSE pr.status
		       END,
		       throttle_count = CASE
		         WHEN os.old_status = 'throttled' THEN 0
		         ELSE pr.throttle_count
		       END,
		       recent_failure_count = CASE
		         WHEN os.old_status = 'throttled' THEN 0
		         ELSE GREATEST(0, pr.recent_failure_count - 1)
		       END,
		       last_failure_at = CASE
		         WHEN os.old_status = 'throttled' THEN NULL
		         ELSE pr.last_failure_at
		       END,
		       status_reason = CASE
		         WHEN os.old_status = 'offline'                  THEN 'Recovering: first check-in after offline'
		         WHEN os.old_status IN ('throttled', 'dormant')  THEN 'Recovered on check-in'
		         ELSE pr.status_reason
		       END,
		       alert_sent_at = CASE
		         WHEN os.old_status = 'dormant' AND os.old_alert_sent_at IS NOT NULL THEN NULL
		         ELSE pr.alert_sent_at
		       END,
		       updated_at = now()
		   FROM old_state os
		   WHERE pr.id = os.id
		   RETURNING pr.id, pr.status AS new_status, pr.project_id
		 )
		 SELECT u.new_status, u.project_id,
		        o.old_status,
		        (o.old_alert_sent_at IS NOT NULL) AS had_alert
		 FROM updated u
		 JOIN old_state o ON u.id = o.id`,
		[agencyIdentity],
	);

	if (!result.rows.length) return;

	const row = result.rows[0];
	// Dormant→active with prior offline alert: emit a single resolved notification
	if (
		row.old_status === "dormant" &&
		row.new_status === "active" &&
		row.had_alert
	) {
		const scope = row.project_id ? `project:${row.project_id}` : "platform";
		await _discordSend(
			"agency-resolver",
			`Agency \`${agencyIdentity}\` recovered from offline (${scope})`,
			"success",
		);
	}
}

/**
 * Operator short-circuit: resume an agency from any non-retired state (P765-AC2).
 * Sets status='active', clears alert_sent_at, and posts a resolved Discord notice
 * if an offline alert had been sent.
 *
 * @param agencyIdentity — roadmap.agency.agency_id TEXT identity string
 */
export async function operatorResumeAgency(
	agencyIdentity: string,
): Promise<void> {
	const result = await query(
		`WITH old_state AS (
		   SELECT pr.id, pr.alert_sent_at AS old_alert_sent_at, pr.project_id
		   FROM roadmap_workforce.provider_registry pr
		   JOIN roadmap_workforce.agent_registry ar ON pr.agency_id = ar.id
		   WHERE ar.agent_identity = $1
		     AND pr.status NOT IN ('retired')
		 ),
		 updated AS (
		   UPDATE roadmap_workforce.provider_registry pr
		   SET status        = 'active',
		       status_reason = 'Operator resume',
		       alert_sent_at = NULL,
		       updated_at    = now()
		   FROM old_state os
		   WHERE pr.id = os.id
		   RETURNING pr.id, pr.project_id
		 )
		 SELECT u.project_id,
		        (o.old_alert_sent_at IS NOT NULL) AS had_alert
		 FROM updated u
		 JOIN old_state o ON u.id = o.id`,
		[agencyIdentity],
	);

	if (!result.rows.length) return;

	const row = result.rows[0];
	if (row.had_alert) {
		const scope = row.project_id ? `project:${row.project_id}` : "platform";
		await _discordSend(
			"agency-resolver",
			`Agency \`${agencyIdentity}\` resumed by operator (${scope})`,
			"success",
		);
	}
}

/**
 * Emit a Discord warning for each agency that has been offline > 10 minutes
 * without an alert already sent (P765-AC3, AC-4).
 *
 * Sets alert_sent_at on every flagged row so the alert fires exactly once
 * per offline episode. Returns the number of agencies alerted.
 */
export async function emitOfflineAlerts(): Promise<number> {
	const result = await query(
		`WITH flagged AS (
		   UPDATE roadmap_workforce.provider_registry pr
		   SET alert_sent_at = now(),
		       updated_at    = now()
		   FROM roadmap_workforce.agent_registry ar
		   WHERE pr.agency_id = ar.id
		     AND pr.status = 'offline'
		     AND pr.alert_sent_at IS NULL
		     AND pr.last_seen_at IS NOT NULL
		     AND now() - pr.last_seen_at > interval '10 minutes'
		   RETURNING pr.project_id, ar.agent_identity
		 )
		 SELECT project_id, agent_identity FROM flagged`,
	);

	for (const row of result.rows) {
		const scope = row.project_id ? `project:${row.project_id}` : "platform";
		await _discordSend(
			"agency-resolver",
			`Agency \`${row.agent_identity}\` has been offline > 10 min (${scope})`,
			"warning",
		);
	}

	return result.rows.length;
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
