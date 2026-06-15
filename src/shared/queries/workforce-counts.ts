/**
 * P1377: canonical workforce metrics.
 *
 * The TUI cockpit previously derived counts from an in-memory label array with
 * three defects: (1) `ready ⊄ online` count-math contradiction, (2) "agencies"
 * actually counted distinct provider@host roles, (3) no distinction between
 * agent_registry rows and rows that have a formal roadmap.agency registration.
 *
 * This module is the single source of truth. Counts come from
 * agent_registry LEFT JOIN roadmap.agency, with definitions chosen so the
 * invariant `online ≤ registered ≤ total` holds by construction.
 *
 * NOTE: this corrects the SQL in the P1377 design, which filtered `online_count`
 * only on presence_state and so did NOT guarantee `online ≤ registered`. Per
 * AC-10 the online set requires a roadmap.agency row, so the filter here also
 * requires `a.agency_id IS NOT NULL`.
 */

export interface WorkforceMetrics {
	/** active, un-reaped agent_registry rows */
	total_agents: number;
	/** distinct preferred_provider among active agents */
	total_providers: number;
	/** active agents that are registered AND present (online|busy) */
	online_count: number;
	/** active agents with a matching roadmap.agency row */
	registered_agencies: number;
	/** active agents WITHOUT a roadmap.agency row (registration drift, P1372) */
	drift_count: number;
}

/** One agent_registry ⋈ roadmap.agency row, as the metrics consume it. */
export interface WorkforceRow {
	status: string | null;
	reaped_at: unknown; // Date | string | null — only null vs non-null matters
	preferred_provider: string | null;
	presence_state: string | null;
	agency_id: string | null;
}

const ONLINE_PRESENCE = new Set(["online", "busy"]);

/**
 * Pure metrics derivation — same semantics as WORKFORCE_METRICS_SQL, so the SQL
 * and the cockpit can be cross-checked against fixtures without a DB.
 */
export function computeWorkforceMetrics(
	rows: WorkforceRow[],
): WorkforceMetrics {
	const active = rows.filter(
		(r) => r.status === "active" && r.reaped_at == null,
	);
	const providers = new Set<string>();
	let online = 0;
	let registered = 0;
	let drift = 0;
	for (const r of active) {
		if (r.preferred_provider) providers.add(r.preferred_provider);
		const isRegistered = r.agency_id != null;
		if (isRegistered) {
			registered++;
			if (r.presence_state && ONLINE_PRESENCE.has(r.presence_state)) online++;
		} else {
			drift++;
		}
	}
	return {
		total_agents: active.length,
		total_providers: providers.size,
		online_count: online,
		registered_agencies: registered,
		drift_count: drift,
	};
}

/** Canonical metrics query — one round-trip, five integer columns. */
export const WORKFORCE_METRICS_SQL = `
	SELECT
	  count(ar.*) FILTER (WHERE ar.status='active' AND ar.reaped_at IS NULL) AS total_agents,
	  count(DISTINCT ar.preferred_provider) FILTER (WHERE ar.status='active' AND ar.reaped_at IS NULL) AS total_providers,
	  count(ar.*) FILTER (WHERE ar.status='active' AND ar.reaped_at IS NULL
	                        AND a.agency_id IS NOT NULL
	                        AND a.presence_state IN ('online','busy')) AS online_count,
	  count(ar.*) FILTER (WHERE ar.status='active' AND ar.reaped_at IS NULL AND a.agency_id IS NOT NULL) AS registered_agencies,
	  count(ar.*) FILTER (WHERE ar.status='active' AND ar.reaped_at IS NULL AND a.agency_id IS NULL) AS drift_count
	FROM roadmap_workforce.agent_registry ar
	LEFT JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
`;

type QueryFn = <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

/** Run the canonical query and return numeric metrics (NaN-safe). */
export async function queryWorkforceMetrics(
	query: QueryFn,
): Promise<WorkforceMetrics> {
	const { rows } = await query<Record<string, string | number>>(
		WORKFORCE_METRICS_SQL,
	);
	const r = rows[0] ?? {};
	const n = (v: string | number | undefined) => Number(v ?? 0) || 0;
	return {
		total_agents: n(r.total_agents),
		total_providers: n(r.total_providers),
		online_count: n(r.online_count),
		registered_agencies: n(r.registered_agencies),
		drift_count: n(r.drift_count),
	};
}
