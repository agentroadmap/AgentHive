/**
 * P1065 — Presence Board: SQL surface.
 *
 * All SQL the panel runs lives here as parameterised string constants so it can
 * be reviewed + lint-checked in one place and the panel body stays
 * blessed-only. Every statement targets the REAL live schema (verified with
 * \d on 2026-06-14); NONE reference fn_agency_status_for, agency.*, workforce.*
 * or the fabricated columns in the AC text. Panel code MUST run these via
 * ctx.query (the shared pool) — panels never open their own pg connection
 * (AC-12).
 */

import type { AgencyRow, MessageRow, TrustRow } from "./presence-board-model.ts";

/**
 * AC-1/AC-8/AC-13/AC-25: fleet rows from roadmap.v_agency_status, LEFT-JOINed
 * laterally to the most-recent NON-TERMINAL squad_dispatch for that agency
 * (matched on squad_dispatch.agency_identity = v_agency_status.agency_id) to
 * surface the active task's proposal display_id.
 *
 * Sorting is finalised in JS (sortAgencyRows) so the offline/silence rule is
 * unit-testable; the SQL ORDER BY is just a deterministic pre-sort.
 */
export const FLEET_SQL = `
SELECT
  vs.agency_id,
  vs.display_name,
  vs.status,
  vs.presence_state,
  COALESCE(vs.silence_seconds, 0)::float8        AS silence_seconds,
  COALESCE(vs.dispatchable, false)               AS dispatchable,
  vs.liveness_state,
  COALESCE(vs.has_live_listener, false)          AS has_live_listener,
  at.active_task
FROM roadmap.v_agency_status vs
LEFT JOIN LATERAL (
  SELECT p.display_id AS active_task
  FROM roadmap_workforce.squad_dispatch sd
  JOIN roadmap_proposal.proposal p ON p.id = sd.proposal_id
  WHERE sd.agency_identity = vs.agency_id
    AND sd.dispatch_status NOT IN ('completed','failed','cancelled')
  ORDER BY sd.assigned_at DESC
  LIMIT 1
) at ON true
ORDER BY (vs.presence_state = 'offline'), vs.silence_seconds DESC
`;

/**
 * AC-4/AC-11/AC-19/AC-22: last N liaison_message rows for an agency, newest
 * first. direction is split into inbox/outbox in JS (splitMessages). acked_at
 * (protocol ack) drives the unacked-offer warning.
 */
export const MESSAGES_SQL = `
SELECT
  message_id::text                                AS message_id,
  direction,
  kind,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  CASE WHEN acked_at IS NULL THEN NULL
       ELSE to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  END                                             AS acked_at
FROM roadmap.liaison_message
WHERE agency_id = $1
ORDER BY created_at DESC
LIMIT $2
`;

/**
 * AC-5/AC-12/AC-20 (outgoing): agents the selected agency trusts. The
 * selected agency_id (e.g. 'codex-bot-andy.a') is matched to agent_trust via
 * agent_identity. roadmap_workforce.agent_trust has no granted_at — we expose
 * created_at as the grant timestamp.
 */
export const TRUST_OUT_SQL = `
SELECT
  agent_identity,
  trusted_agent,
  trust_level,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  CASE WHEN expires_at IS NULL THEN NULL
       ELSE to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  END AS expires_at
FROM roadmap_workforce.agent_trust
WHERE agent_identity = $1
ORDER BY trust_level, trusted_agent
`;

/** AC-5/AC-12 (incoming): agents who trust the selected agency. */
export const TRUST_IN_SQL = `
SELECT
  agent_identity,
  trusted_agent,
  trust_level,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  CASE WHEN expires_at IS NULL THEN NULL
       ELSE to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  END AS expires_at
FROM roadmap_workforce.agent_trust
WHERE trusted_agent = $1
ORDER BY trust_level, agent_identity
`;

/**
 * AC-7/AC-14/AC-23: probe whether P1050's fn_agency_status_for is deployed.
 * Returns one row {present: bool}. When false the board shows the unfiltered
 * fallback banner. This is the ONLY place the function name appears, and only
 * as a catalog probe — never as a callable dependency.
 */
export const STATUS_FOR_PROBE_SQL = `
SELECT EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'fn_agency_status_for'
) AS present
`;

export type ShellQueryFn = <R = Record<string, unknown>>(
	text: string,
	params?: unknown[],
) => Promise<{ rows: R[] }>;

/** Run the fleet query through the shell's shared pool (AC-12). */
export async function fetchFleet(query: ShellQueryFn): Promise<AgencyRow[]> {
	const { rows } = await query<AgencyRow>(FLEET_SQL);
	return rows.map((r) => ({
		...r,
		silence_seconds: Number(r.silence_seconds),
	}));
}

export async function fetchMessages(
	query: ShellQueryFn,
	agencyId: string,
	limit = 40,
): Promise<MessageRow[]> {
	const { rows } = await query<MessageRow>(MESSAGES_SQL, [agencyId, limit]);
	return rows;
}

export async function fetchTrust(
	query: ShellQueryFn,
	agencyId: string,
): Promise<{ outgoing: TrustRow[]; incoming: TrustRow[] }> {
	const [out, inc] = await Promise.all([
		query<TrustRow>(TRUST_OUT_SQL, [agencyId]),
		query<TrustRow>(TRUST_IN_SQL, [agencyId]),
	]);
	return { outgoing: out.rows, incoming: inc.rows };
}

export async function probeStatusForFn(query: ShellQueryFn): Promise<boolean> {
	const { rows } = await query<{ present: boolean }>(STATUS_FOR_PROBE_SQL);
	return rows[0]?.present ?? false;
}
