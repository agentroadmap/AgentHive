/**
 * Liaison Service — Agency registration, heartbeat, and dormancy management.
 *
 * Dormancy state machine:
 *   active ↔ throttled (self-declared by liaison)
 *   ↓
 *   dormant (90s silence — fn_check_agency_dormancy watchdog)
 *   ↓
 *   active (next heartbeat restores; CASE branch handles dormant→active)
 */

import type { PoolClient } from "pg";
import { query } from "../postgres/pool.ts";
import { recordCheckIn } from "../../core/orchestration/resolvers/agency-resolver.ts";

export interface LiaisonRegisterPayload {
	agency_id: string;
	display_name: string;
	provider: string;
	host_id: string;
	capabilities?: string[];
	capacity_envelope?: Record<string, unknown>;
	public_key?: string;
	metadata?: Record<string, unknown>;
}

export interface LiaisonHeartbeatPayload {
	session_id: string;
	capacity_envelope?: Record<string, unknown>;
	in_flight_cubic_count?: number;
	last_error?: string | null;
	status?: "active" | "throttled" | "paused";
}

export interface LiaisonRegisterResult {
	session_id: string;
	agency_id: string;
	status: string;
}

export interface LiaisonHeartbeatResult {
	success: boolean;
	agency_status: string;
	silence_seconds: number;
	dispatchable: boolean;
}

/**
 * Register an agency and open a liaison session.
 *
 * P913: accepts an optional PoolClient so callers (selfRegisterAgency) can
 * include this work in their own transaction. When client is omitted, falls
 * back to the pool's auto-commit query() helper for backward compatibility.
 */
export async function liaisonRegister(
	payload: LiaisonRegisterPayload,
	client?: PoolClient,
): Promise<LiaisonRegisterResult> {
	const {
		agency_id,
		display_name,
		provider,
		host_id,
		capabilities = [],
		capacity_envelope = {},
		public_key,
		metadata = {},
	} = payload;

	if (!agency_id?.trim()) throw new Error("agency_id is required");
	if (!provider?.trim()) throw new Error("provider is required");
	if (!host_id?.trim()) throw new Error("host_id is required");

	const runQuery = client
		? <T extends Record<string, unknown>>(text: string, params?: unknown[]) =>
				client.query<T>(text, params as never)
		: query;

	// End any active session first in a separate statement — PostgreSQL CTEs share
	// the same snapshot, so an UPDATE in one CTE is invisible to an INSERT in
	// another CTE of the same statement. The unique partial index
	// idx_agency_session_one_active (WHERE ended_at IS NULL) would fire because
	// the INSERT still sees the old un-ended row.
	await runQuery(
		`UPDATE roadmap.agency_liaison_session
		 SET ended_at = now(), end_reason = 'replaced'
		 WHERE agency_id = $1 AND ended_at IS NULL`,
		[agency_id],
	);

	const result = await runQuery(
		`
    WITH upsert_agency AS (
      INSERT INTO roadmap.agency (
        agency_id, display_name, provider, host_id, capability_tags, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
      ON CONFLICT (agency_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        provider     = EXCLUDED.provider,
        host_id      = EXCLUDED.host_id,
        capability_tags = EXCLUDED.capability_tags,
        status       = 'active',
        status_reason = NULL
      RETURNING agency_id, status
    ),
    insert_session AS (
      INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
      VALUES ($1, inet_server_addr()::text, now())
      RETURNING session_id
    )
    SELECT
      (SELECT session_id FROM insert_session) as session_id,
      (SELECT agency_id  FROM upsert_agency)  as agency_id,
      (SELECT status     FROM upsert_agency)  as status
    `,
		[
			agency_id,
			display_name,
			provider,
			host_id,
			capabilities,
			JSON.stringify({ ...metadata, capacity_envelope, public_key }),
		],
	) as { rows: Array<{ session_id: string; agency_id: string; status: string }> };

	if (result.rows.length === 0)
		throw new Error(`Failed to register agency ${agency_id}`);

	const row = result.rows[0];
	return {
		session_id: row.session_id,
		agency_id: row.agency_id,
		status: row.status,
	};
}

/**
 * Process a heartbeat from a liaison.
 *
 * AC-4 fix: dormant agencies MUST be reactivated when a heartbeat arrives.
 * The CASE now has an explicit `WHEN status = 'dormant' THEN 'active'` branch
 * BEFORE the liaison-declared status branches so a recovering agency always
 * transitions back to active rather than staying frozen in 'dormant'.
 *
 * P765 AC-1: offline agencies transition to 'dormant' on first heartbeat,
 * then to 'active' on the next tick (two-step auto-recovery). offline_alert_sent_at
 * is cleared at the start of recovery so the resolved-alert fires on full recovery.
 */
export async function liaisonHeartbeat(
	payload: LiaisonHeartbeatPayload,
): Promise<LiaisonHeartbeatResult> {
	const {
		session_id,
		capacity_envelope,
		status: liaison_status = "active",
	} = payload;

	if (!session_id) throw new Error("session_id is required");

	// Fetch session and agency info
	const sessionResult = await query(
		`SELECT agency_id, ended_at FROM roadmap.agency_liaison_session WHERE session_id = $1`,
		[session_id],
	);

	if (sessionResult.rows.length === 0)
		throw new Error(`Session ${session_id} not found or already ended`);

	const { agency_id, ended_at } = sessionResult.rows[0];

	if (ended_at !== null)
		throw new Error(`Session ${session_id} already ended`);

	// Update agency status and metadata (reactivate if dormant, set liaison_status)
	await query(
		`
    UPDATE roadmap.agency
    SET
      status = CASE
        WHEN status = 'offline'      THEN 'dormant'     -- P765 AC-1: first step of two-step auto-recovery
        WHEN status = 'dormant'      THEN 'active'      -- reactivate on heartbeat
        WHEN $2 = 'throttled'        THEN 'throttled'
        WHEN $2 = 'paused'           THEN 'paused'
        ELSE status
      END,
      status_reason = CASE
        WHEN status = 'offline' THEN 'Auto-recovery: first heartbeat received'
        WHEN status = 'dormant' THEN 'Reactivated by heartbeat'
        ELSE status_reason
      END,
      metadata = jsonb_set(metadata, '{capacity_envelope}', $3::jsonb)
    WHERE agency_id = $1
    `,
		[agency_id, liaison_status, JSON.stringify(capacity_envelope ?? {})],
	);

	// Compute presence state: busy if active dispatch or running agent, else online.
	// squad_dispatch lives in roadmap_workforce; agent_runs lives in roadmap.
	// Both tables key on `agent_identity` (which holds the agency_id value).
	const stateResult = await query(
		`
    SELECT
      CASE
        WHEN EXISTS(
          SELECT 1 FROM roadmap_workforce.squad_dispatch
          WHERE agent_identity = $1
            AND dispatch_status IN ('assigned', 'active')
            AND completed_at IS NULL
        ) THEN 'busy'
        WHEN EXISTS(
          SELECT 1 FROM roadmap.agent_runs
          WHERE agent_identity = $1 AND status = 'running'
        ) THEN 'busy'
        ELSE 'online'
      END AS computed_state
    `,
		[agency_id],
	);

	const computed_state = stateResult.rows[0]?.computed_state || "online";

	// Call fn_pulse to atomically update heartbeat + presence_state and emit notify
	await query(
		`SELECT roadmap.fn_pulse($1, $2)`,
		[agency_id, computed_state],
	);

	// Fetch final agency state for response. Use v_agency_status so dispatchable
	// honors both presence_state (canonical, A2A maintains) and last_heartbeat_at
	// freshness (transitional fallback) — P1132 view migration.
	const finalResult = await query(
		`
    SELECT status, last_heartbeat_at, silence_seconds::int as silence_seconds, dispatchable
    FROM roadmap.v_agency_status
    WHERE agency_id = $1
    `,
		[agency_id],
	);

	if (finalResult.rows.length === 0)
		throw new Error(`Agency ${agency_id} not found after update`);

	const row = finalResult.rows[0];

	// P765 AC-1: keep provider_registry.last_seen_at in sync so the
	// offline-alert sweep and dispatch resolver see fresh liveness.
	// Fire-and-forget — heartbeat must not fail if provider_registry is
	// momentarily unavailable (agency may not yet have a registry row).
	recordCheckIn(agency_id).catch((err) =>
		console.warn("[liaison] recordCheckIn failed:", err),
	);

	return {
		success: true,
		agency_status: row.status,
		silence_seconds: row.silence_seconds ?? 0,
		dispatchable: row.dispatchable,
	};
}

/**
 * Mark dormant any agencies whose liveness signals all say absent.
 * Called by the liaison boot-process watchdog every 60s (AC-5).
 *
 * Aliveness signals (any one keeps the agency out of dormant):
 *   - pg_stat_activity holds 'agenthive-a2a-listen-<agency_id>' — CANONICAL
 *     crash detection (task #39 / Phase A). The A2A host opens this LISTEN
 *     session per attached agency; when the host crashes or the connection
 *     drops, the row disappears from pg_stat_activity within seconds — much
 *     faster than 90s heartbeat staleness.
 *   - presence_state IN ('online', 'busy') — set on lifecycle events by
 *     fn_pulse. Stale on crash (presence stays 'online'), but useful when
 *     pg_stat_activity briefly lacks the row mid-reconnect.
 *   - last_heartbeat_at < 90 s — transitional fallback while the
 *     A2A presence-refresh shim still writes. Retires in Phase B once
 *     pg_stat_activity is proven sufficient.
 */
export async function checkAndMarkDormant(): Promise<number> {
	const result = await query(`
    UPDATE roadmap.agency a
    SET status = 'dormant', status_reason = 'No liveness signal > 90s'
    WHERE a.status IN ('active', 'throttled')
      AND NOT (
        EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE application_name = 'agenthive-a2a-listen-' || a.agency_id
        )
        OR a.presence_state IN ('online', 'busy')
        OR (a.last_heartbeat_at IS NOT NULL
            AND (now() - a.last_heartbeat_at) < interval '90 seconds')
      )
    RETURNING a.agency_id
  `);
	return result.rowCount ?? 0;
}

/**
 * P765 AC-5: Mark offline any dormant agencies past the 5-minute silence threshold.
 * Called by the liveness alerting maintenance tick.
 */
export async function checkAndMarkOffline(): Promise<number> {
	const result = await query(`
    UPDATE roadmap.agency
    SET status = 'offline', status_reason = 'No heartbeat > 5 min'
    WHERE status = 'dormant'
      AND last_heartbeat_at IS NOT NULL
      AND (now() - last_heartbeat_at) > interval '5 minutes'
    RETURNING agency_id
  `);
	return result.rowCount ?? 0;
}

/**
 * P765 AC-2: Operator short-circuit resume — transitions any non-retired agency
 * directly to 'active', bypassing the two-step auto-recovery flow.
 * Also clears offline_alert_sent_at so the recovery alert fires.
 */
export async function liaisonResume(agency_id: string): Promise<string> {
	if (!agency_id?.trim()) throw new Error("agency_id is required");

	const result = await query(
		`
    UPDATE roadmap.agency
    SET status = 'active',
        status_reason = 'Operator resume',
        offline_alert_sent_at = NULL
    WHERE agency_id = $1 AND status NOT IN ('retired')
    RETURNING status
    `,
		[agency_id],
	);

	if (result.rowCount === 0)
		throw new Error(`Agency ${agency_id} not found or retired`);

	return "active";
}

/**
 * Manually reactivate a dormant agency.
 */
export async function agencyReactivate(agency_id: string): Promise<string> {
	if (!agency_id?.trim()) throw new Error("agency_id is required");

	const result = await query(
		`
    UPDATE roadmap.agency
    SET status = 'active', status_reason = NULL
    WHERE agency_id = $1 AND status IN ('dormant', 'offline')
    RETURNING status
    `,
		[agency_id],
	);

	if (result.rowCount === 0)
		throw new Error(`Agency ${agency_id} not found or not dormant/offline`);

	return "active";
}

/**
 * P765 AC-2: Operator resume — force an agency to active from any non-retired state.
 * Updates both roadmap.agency (liaison layer) and provider_registry (liveness layer).
 * Clears all offline/throttle tracking state. Idempotent if already active.
 */
export async function agencyResume(agency_id: string): Promise<string> {
	if (!agency_id?.trim()) throw new Error("agency_id is required");

	await query(
		`UPDATE roadmap.agency
		 SET status = 'active', status_reason = 'Operator resume'
		 WHERE agency_id = $1 AND status <> 'retired'`,
		[agency_id],
	);

	await query(
		`UPDATE roadmap_workforce.provider_registry pr
		 SET status              = 'active',
		     status_reason       = 'Operator resume',
		     offline_since_at    = NULL,
		     offline_alerted_at  = NULL,
		     throttle_count      = 0,
		     recent_failure_count = 0,
		     last_failure_at     = NULL,
		     updated_at          = now()
		 FROM roadmap_workforce.agent_registry ar
		 WHERE pr.agency_id = ar.id
		   AND ar.agent_identity = $1
		   AND pr.status <> 'retired'`,
		[agency_id],
	);

	return "active";
}

/**
 * End a liaison session on shutdown or crash.
 */
export async function endLiaisonSession(
	session_id: string,
	reason: "normal" | "crash" | "operator" | "throttle" = "normal",
): Promise<void> {
	const result = await query(
		`
    UPDATE roadmap.agency_liaison_session
    SET ended_at = now(), end_reason = $1
    WHERE session_id = $2 AND ended_at IS NULL
    RETURNING agency_id
    `,
		[reason, session_id],
	);

	if (result.rowCount === 0)
		throw new Error(`Session ${session_id} not found or already ended`);
}

/**
 * Check whether an agency has an active (non-ended) liaison session.
 * Used by the prop_claim gateway to enforce AC-7.
 */
export async function hasActiveLiaisonSession(
	agency_id: string,
): Promise<boolean> {
	const result = await query(
		`
    SELECT 1 FROM roadmap.agency_liaison_session
    WHERE agency_id = $1 AND ended_at IS NULL
    LIMIT 1
    `,
		[agency_id],
	);
	return (result.rowCount ?? 0) > 0;
}

/**
 * Check if an identity is a registered agency.
 */
export async function isRegisteredAgency(identity: string): Promise<boolean> {
	const result = await query(
		`SELECT 1 FROM roadmap.agency WHERE agency_id = $1 LIMIT 1`,
		[identity],
	);
	return (result.rowCount ?? 0) > 0;
}

/**
 * Get the current status of an agency.
 */
export async function getAgencyStatus(agency_id: string): Promise<{
	agency_id: string;
	display_name: string;
	status: string;
	silence_seconds: number;
	dispatchable: boolean;
	liveness_state: string;
} | null> {
	const result = await query(
		`
    SELECT agency_id, display_name, status, silence_seconds, dispatchable, liveness_state
    FROM roadmap.v_agency_status
    WHERE agency_id = $1
    `,
		[agency_id],
	);
	return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Check whether a single agency is dispatchable.
 *
 * Dispatachability criteria (v_agency_status):
 *   - status = 'active'
 *   - last_heartbeat_at within 60 seconds
 *
 * @note Capacity envelope check (remaining_capacity > 0) is disabled and
 *   treated as true until P1018/P1022 land (budget substrate unwired).
 */
export async function isAgencyDispatchable(agencyId: string): Promise<boolean> {
	const result = await query(
		`SELECT dispatchable FROM roadmap.v_agency_status WHERE agency_id = $1 LIMIT 1`,
		[agencyId],
	);
	return result.rows[0]?.dispatchable === true;
}

/**
 * List all dispatchable agencies (active, within 90s heartbeat).
 *
 * Checks: status='active' AND last_heartbeat_at < 90s (via v_agency_status.dispatchable).
 * @note Capacity envelope check (remaining_capacity > 0) is treated as always-true
 *   until P1018/P1022 land and wire the budget substrate writers.
 */
export async function listDispatchableAgencies(): Promise<
	Array<{
		agency_id: string;
		display_name: string;
		provider: string;
		status: string;
	}>
> {
	const result = await query(`
    SELECT agency_id, display_name, provider, status
    FROM roadmap.v_agency_status
    WHERE dispatchable = true
    ORDER BY agency_id
  `);
	return result.rows;
}
