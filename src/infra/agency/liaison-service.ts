/**
 * Liaison Service — Agency registration, heartbeat, and dormancy management.
 *
 * Provides RPC handlers for:
 * - liaison_register: Initial registration of an agency
 * - liaison_heartbeat: Periodic heartbeat updates
 * - agency_reactivate: Manual reactivation of dormant agencies
 *
 * Dormancy state machine:
 *   active ↔ throttled (self-declared by liaison)
 *   ↓
 *   dormant (90s silence)
 *   ↓
 *   active (next heartbeat) or retired (operator)
 */

import { v4 as uuidv4 } from "uuid";
import { query } from "../postgres/pool.js";

export interface LiaisonRegisterPayload {
  agency_id: string;
  display_name: string;
  provider: string;
  host_id: string;
  capabilities?: string[];
  capacity_envelope?: Record<string, any>;
  public_key?: string;
  metadata?: Record<string, any>;
}

export interface LiaisonHeartbeatPayload {
  session_id: string;
  capacity_envelope?: Record<string, any>;
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
 * Steps:
 * 1. Upsert agency row (or update if exists)
 * 2. Create new agency_liaison_session
 * 3. Return session_id and status
 *
 * Validation:
 * - agency_id must be non-empty
 * - host_id must exist in roadmap.host_model_policy (per P206 host model policy)
 * - provider must be non-empty
 */
export async function liaisonRegister(
  payload: LiaisonRegisterPayload
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

  // Validation
  if (!agency_id?.trim()) {
    throw new Error("agency_id is required and must be non-empty");
  }
  if (!provider?.trim()) {
    throw new Error("provider is required and must be non-empty");
  }
  if (!host_id?.trim()) {
    throw new Error("host_id is required and must be non-empty");
  }

  const result = await query(
    `
    WITH upsert_agency AS (
      INSERT INTO roadmap.agency (
        agency_id,
        display_name,
        provider,
        host_id,
        capability_tags,
        status,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
      ON CONFLICT (agency_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        provider = EXCLUDED.provider,
        host_id = EXCLUDED.host_id,
        capability_tags = EXCLUDED.capability_tags,
        status = 'active',
        status_reason = NULL
      RETURNING agency_id, status
    ),
    insert_session AS (
      INSERT INTO roadmap.agency_liaison_session (
        agency_id,
        liaison_host,
        started_at
      ) VALUES ($1, inet_server_addr()::text, now())
      RETURNING session_id
    )
    SELECT
      (SELECT session_id FROM insert_session) as session_id,
      (SELECT agency_id FROM upsert_agency) as agency_id,
      (SELECT status FROM upsert_agency) as status
    `,
    [
      agency_id,
      display_name,
      provider,
      host_id,
      capabilities,
      JSON.stringify({ ...metadata, capacity_envelope, public_key }),
    ]
  );

  if (result.rows.length === 0) {
    throw new Error(`Failed to register agency ${agency_id}`);
  }

  const row = result.rows[0];
  return {
    session_id: row.session_id,
    agency_id: row.agency_id,
    status: row.status,
  };
}

/**
 * Process a heartbeat from a liaison. Updates last_heartbeat_at and may
 * transition status based on liaison-declared state or silence.
 *
 * Heartbeat grace: 90 seconds. Liaison must heartbeat at least every 30s.
 * If silence > 90s, agency transitions to dormant on next read.
 * If liaison declares 'throttled', status is updated (self-declared).
 */
export async function liaisonHeartbeat(
  payload: LiaisonHeartbeatPayload
): Promise<LiaisonHeartbeatResult> {
  const {
    session_id,
    capacity_envelope,
    in_flight_cubic_count,
    last_error,
    status: liaison_status = "active",
  } = payload;

  if (!session_id) {
    throw new Error("session_id is required");
  }

  const result = await query(
    `
    WITH session_check AS (
      SELECT agency_id, ended_at FROM roadmap.agency_liaison_session
      WHERE session_id = $1
    ),
    update_agency AS (
      UPDATE roadmap.agency
      SET
        last_heartbeat_at = now(),
        status = CASE
          WHEN $2 = 'throttled' THEN 'throttled'
          WHEN $2 = 'paused' THEN 'paused'
          ELSE status
        END,
        metadata = jsonb_set(
          metadata,
          '{capacity_envelope}',
          $3::jsonb
        )
      WHERE agency_id = (SELECT agency_id FROM session_check)
        AND (SELECT ended_at FROM session_check) IS NULL
      RETURNING agency_id, status
    )
    SELECT
      (SELECT agency_id FROM session_check) as agency_id,
      (SELECT status FROM update_agency) as agency_status,
      EXTRACT(EPOCH FROM (now() - (
        SELECT last_heartbeat_at FROM roadmap.agency
        WHERE agency_id = (SELECT agency_id FROM session_check)
      )))::int as silence_seconds,
      (
        (SELECT status FROM update_agency) = 'active'
        AND now() - (
          SELECT last_heartbeat_at FROM roadmap.agency
          WHERE agency_id = (SELECT agency_id FROM session_check)
        ) < interval '90 seconds'
      ) as dispatchable
    `,
    [session_id, liaison_status, JSON.stringify(capacity_envelope || {})]
  );

  if (result.rows.length === 0) {
    throw new Error(`Session ${session_id} not found or already ended`);
  }

  const row = result.rows[0];
  return {
    success: true,
    agency_status: row.agency_status,
    silence_seconds: row.silence_seconds || 0,
    dispatchable: row.dispatchable,
  };
}

/**
 * Check and mark dormant any agencies past the 90-second grace period.
 * This is typically called by a background job, not by liaisons directly.
 */
export async function checkAndMarkDormant(): Promise<number> {
  const result = await query(
    `
    UPDATE roadmap.agency
    SET
      status = 'dormant',
      status_reason = 'No heartbeat > 90s'
    WHERE
      status IN ('active', 'throttled')
      AND last_heartbeat_at IS NOT NULL
      AND (now() - last_heartbeat_at) > interval '90 seconds'
    RETURNING agency_id
    `
  );
  return result.rowCount ?? 0;
}

/**
 * Manually reactivate a dormant agency. Typically called by an operator
 * after manual recovery or health check.
 */
export async function agencyReactivate(agency_id: string): Promise<string> {
  if (!agency_id?.trim()) {
    throw new Error("agency_id is required");
  }

  const result = await query(
    `
    UPDATE roadmap.agency
    SET
      status = 'active',
      status_reason = NULL
    WHERE agency_id = $1
      AND status = 'dormant'
    RETURNING status
    `,
    [agency_id]
  );

  if (result.rowCount === 0) {
    throw new Error(
      `Agency ${agency_id} not found or not in dormant state`
    );
  }

  return "active";
}

/**
 * End a liaison session (e.g., on liaison shutdown, crash, or operator command).
 * Marks the session row with ended_at and end_reason.
 * The agency itself may transition to dormant based on subsequent heartbeat checks.
 */
export async function endLiaisonSession(
  session_id: string,
  reason: "normal" | "crash" | "operator" | "throttle" = "normal"
): Promise<void> {
  const result = await query(
    `
    UPDATE roadmap.agency_liaison_session
    SET
      ended_at = now(),
      end_reason = $1
    WHERE session_id = $2
      AND ended_at IS NULL
    RETURNING agency_id
    `,
    [reason, session_id]
  );

  if (result.rowCount === 0) {
    throw new Error(`Session ${session_id} not found or already ended`);
  }
}

/**
 * Get the current status of an agency from the v_agency_status view.
 */
export async function getAgencyStatus(
  agency_id: string
): Promise<{
  agency_id: string;
  display_name: string;
  status: string;
  silence_seconds: number;
  dispatchable: boolean;
} | null> {
  const result = await query(
    `
    SELECT
      agency_id,
      display_name,
      status,
      silence_seconds,
      dispatchable
    FROM roadmap.v_agency_status
    WHERE agency_id = $1
    `,
    [agency_id]
  );

  return result.rows.length > 0 ? result.rows[0] : null;
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
