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

	const registered = await runQuery<{ agency_id: string }>(
		`SELECT agency_id FROM roadmap.agency WHERE agency_id = $1`,
		[agency_id],
	) as { rows: Array<{ agency_id: string }> };
	if (registered.rows.length === 0) {
		throw new Error(
			`Agency ${agency_id} not registered. Register it first via: mcp_agent action='register' args={...}`,
		);
	}

	// V3-C5 (P1437) AC-2: self-heal a STALE orphan active session before inserting
	// a new one. A hard-crashed prior liaison leaves a row with ended_at IS NULL,
	// which the partial unique index idx_agency_session_one_active collides with on
	// restart — looping the unit (codex-agency-bot looped 553x on 2026-05-29).
	//
	// Codex review (P1437 #8683): heal ONLY when the prior liaison is provably
	// dead, never a healthy concurrent one. Guard on the agency heartbeat: a live
	// liaison pulses fn_pulse (~30s) keeping last_heartbeat_at fresh, so we heal
	// only when it is NULL or older than the 90s dispatchable threshold. If a live
	// liaison IS heartbeating, this is a no-op and the INSERT below correctly hits
	// the unique index — rejecting the second liaison instead of split-braining.
	// A separate statement (not a racing CTE) keeps the heal deterministic.
	await runQuery(
		`UPDATE roadmap.agency_liaison_session s
		    SET ended_at = now(),
		        end_reason = COALESCE(end_reason, 'orphan-heal-on-register')
		  WHERE s.agency_id = $1
		    AND s.ended_at IS NULL
		    AND NOT EXISTS (
		      SELECT 1 FROM roadmap.agency a
		       WHERE a.agency_id = $1
		         AND a.last_heartbeat_at IS NOT NULL
		         AND a.last_heartbeat_at > now() - interval '60 seconds'
		    )`,
		[agency_id],
	);

	const result = await runQuery(
		`
    WITH update_agency AS (
      UPDATE roadmap.agency
      SET display_name = $2,
          provider     = $3,
          host_id      = $4,
          capability_tags = $5,
          status       = 'active',
          status_reason = NULL,
          metadata     = $6
      WHERE agency_id = $1
      RETURNING agency_id, status
    ),
    insert_session AS (
      INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
      VALUES ($1, inet_server_addr()::text, now())
      RETURNING session_id
    )
    SELECT
      (SELECT session_id FROM insert_session) as session_id,
      (SELECT agency_id  FROM update_agency)  as agency_id,
      (SELECT status     FROM update_agency)  as status
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

	const result = await query(
		`
    WITH session_check AS (
      SELECT agency_id, ended_at
      FROM roadmap.agency_liaison_session
      WHERE session_id = $1
    ),
    update_agency AS (
      UPDATE roadmap.agency
      SET
        last_heartbeat_at = now(),
        status = CASE
          WHEN status = 'offline'      THEN 'dormant'     -- P765 AC-1: first step of auto-recovery
          WHEN status = 'dormant'      THEN 'active'      -- reactivate on heartbeat
          WHEN $2 = 'throttled'        THEN 'throttled'
          WHEN $2 = 'paused'           THEN 'paused'
          ELSE status
        END,
        offline_alert_sent_at = CASE
          WHEN status = 'offline' THEN NULL               -- clear debounce on recovery start
          ELSE offline_alert_sent_at
        END,
        status_reason = CASE
          WHEN status = 'offline' THEN 'Auto-recovery: first heartbeat received'
          WHEN status = 'dormant' THEN 'Reactivated by heartbeat'
          ELSE status_reason
        END,
        metadata = jsonb_set(metadata, '{capacity_envelope}', $3::jsonb)
      WHERE agency_id = (SELECT agency_id FROM session_check)
        AND (SELECT ended_at FROM session_check) IS NULL
      RETURNING agency_id, status
    )
    SELECT
      (SELECT agency_id FROM session_check)   as agency_id,
      (SELECT status    FROM update_agency)   as agency_status,
      EXTRACT(EPOCH FROM (now() - (
        SELECT last_heartbeat_at FROM roadmap.agency
        WHERE agency_id = (SELECT agency_id FROM session_check)
      )))::int                                as silence_seconds,
      (
        (SELECT status FROM update_agency) = 'active'
        AND now() - (SELECT last_heartbeat_at FROM roadmap.agency
                     WHERE agency_id = (SELECT agency_id FROM session_check))
            < interval '60 seconds'
      )                                       as dispatchable
    `,
		[session_id, liaison_status, JSON.stringify(capacity_envelope ?? {})],
	);

	if (result.rows.length === 0)
		throw new Error(`Session ${session_id} not found or already ended`);

	const row = result.rows[0];

	// P1104: update presence_state via fn_pulse whenever a heartbeat lands
	if (row.agency_id) {
		const presenceState =
			liaison_status === "throttled" ? "busy"
			: liaison_status === "paused"   ? "away"
			: "online";
		await query("SELECT roadmap.fn_pulse($1, $2)", [row.agency_id, presenceState]).catch(() => {});
	}

	return {
		success: true,
		agency_status: row.agency_status,
		silence_seconds: row.silence_seconds ?? 0,
		dispatchable: row.dispatchable,
	};
}

/**
 * Mark dormant any agencies past the 90-second grace period.
 * Called by the liaison boot-process watchdog every 60s (AC-5).
 */
export async function checkAndMarkDormant(): Promise<number> {
	const result = await query(`
    UPDATE roadmap.agency
    SET status = 'dormant', status_reason = 'No heartbeat > 90s'
    WHERE status IN ('active', 'throttled')
      AND last_heartbeat_at IS NOT NULL
      AND (now() - last_heartbeat_at) > interval '60 seconds'
    RETURNING agency_id
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
} | null> {
	const result = await query(
		`
    SELECT agency_id, display_name, status, silence_seconds, dispatchable
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

/**
 * P1104: Signal offline presence via fn_pulse on graceful shutdown.
 * Best-effort — errors are silently swallowed so shutdown is never blocked.
 */
export async function liaisonSetOffline(agency_id: string): Promise<void> {
	await query("SELECT roadmap.fn_pulse($1, $2)", [agency_id, "offline"]).catch(() => {});
}
