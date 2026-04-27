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
 */
export async function liaisonRegister(
	payload: LiaisonRegisterPayload,
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

	const result = await query(
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
	);

	if (result.rows.length === 0)
		throw new Error(`Failed to register agency ${agency_id}`);

	const row = result.rows[0];
	return { session_id: row.session_id, agency_id: row.agency_id, status: row.status };
}

/**
 * Process a heartbeat from a liaison.
 *
 * AC-4 fix: dormant agencies MUST be reactivated when a heartbeat arrives.
 * The CASE now has an explicit `WHEN status = 'dormant' THEN 'active'` branch
 * BEFORE the liaison-declared status branches so a recovering agency always
 * transitions back to active rather than staying frozen in 'dormant'.
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
          WHEN status = 'dormant'      THEN 'active'      -- reactivate on heartbeat
          WHEN $2 = 'throttled'        THEN 'throttled'
          WHEN $2 = 'paused'           THEN 'paused'
          ELSE status
        END,
        status_reason = CASE
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
            < interval '90 seconds'
      )                                       as dispatchable
    `,
		[session_id, liaison_status, JSON.stringify(capacity_envelope ?? {})],
	);

	if (result.rows.length === 0)
		throw new Error(`Session ${session_id} not found or already ended`);

	const row = result.rows[0];
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
      AND (now() - last_heartbeat_at) > interval '90 seconds'
    RETURNING agency_id
  `);
	return result.rowCount ?? 0;
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
    WHERE agency_id = $1 AND status = 'dormant'
    RETURNING status
    `,
		[agency_id],
	);

	if (result.rowCount === 0)
		throw new Error(`Agency ${agency_id} not found or not dormant`);

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
export async function hasActiveLiaisonSession(agency_id: string): Promise<boolean> {
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
 * List all dispatchable agencies (active, within 90s heartbeat).
 */
export async function listDispatchableAgencies(): Promise<
	Array<{ agency_id: string; display_name: string; provider: string; status: string }>
> {
	const result = await query(`
    SELECT agency_id, display_name, provider, status
    FROM roadmap.v_agency_status
    WHERE dispatchable = true
    ORDER BY agency_id
  `);
	return result.rows;
}
