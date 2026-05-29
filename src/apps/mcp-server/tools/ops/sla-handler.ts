/**
 * P081: SLA health_check handler
 * Queries roadmap.trace_span + roadmap_workforce.agent_health + roadmap.sla_config
 * to return current platform SLA state (Normal/Degraded/Down) with live metrics.
 */

import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

export type SlaState = "Normal" | "Degraded" | "Down";

export interface SlaMetrics {
	state: SlaState;
	latency_p99_ms: number | null;
	error_rate_pct: number | null;
	healthy_agents: number;
	total_agents: number;
	stale_agent_pct: number;
	active_leases: number;
	postgres_ok: boolean;
	thresholds: {
		latency_p99_ms: number;
		error_rate_pct: number;
		stale_agent_pct: number;
	};
	checked_at: string;
}

interface SlaThresholds {
	latency_p99_ms: number;
	error_rate_pct: number;
	stale_agent_pct: number;
	latency_window_s: number;
	error_window_s: number;
}

async function loadThresholds(): Promise<SlaThresholds> {
	try {
		const res = await query<{ key: string; value: string }>(
			"SELECT key, value FROM roadmap.sla_config WHERE key = ANY($1)",
			[["latency_p99_ms_threshold", "error_rate_pct_threshold", "stale_agent_pct_threshold", "latency_window_seconds", "error_window_seconds"]],
		);
		const map: Record<string, number> = {};
		for (const row of res.rows) map[row.key] = parseFloat(row.value);
		return {
			latency_p99_ms: map["latency_p99_ms_threshold"] ?? 500,
			error_rate_pct: map["error_rate_pct_threshold"] ?? 10,
			stale_agent_pct: map["stale_agent_pct_threshold"] ?? 20,
			latency_window_s: map["latency_window_seconds"] ?? 300,
			error_window_s: map["error_window_seconds"] ?? 30,
		};
	} catch {
		return { latency_p99_ms: 500, error_rate_pct: 10, stale_agent_pct: 20, latency_window_s: 300, error_window_s: 30 };
	}
}

export async function handleHealthCheck(_args: Record<string, unknown>): Promise<CallToolResult> {
	const t = await loadThresholds();

	// 1. Postgres liveness
	let postgresOk = false;
	try {
		await query("SELECT 1");
		postgresOk = true;
	} catch {
		// postgresOk stays false
	}

	if (!postgresOk) {
		const metrics: SlaMetrics = {
			state: "Down",
			latency_p99_ms: null,
			error_rate_pct: null,
			healthy_agents: 0,
			total_agents: 0,
			stale_agent_pct: 100,
			active_leases: 0,
			postgres_ok: false,
			thresholds: { latency_p99_ms: t.latency_p99_ms, error_rate_pct: t.error_rate_pct, stale_agent_pct: t.stale_agent_pct },
			checked_at: new Date().toISOString(),
		};
		return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }] };
	}

	// 2. p99 latency from trace_span (mcp_tool_call spans in last latency_window_s)
	let latencyP99: number | null = null;
	try {
		const latRes = await query<{ p99_ms: string | null }>(
			`SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (
			     ORDER BY EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
			 ) AS p99_ms
			 FROM roadmap.trace_span
			 WHERE operation = 'mcp_tool_call'
			   AND ended_at IS NOT NULL
			   AND started_at > now() - ($1 * interval '1 second')`,
			[t.latency_window_s],
		);
		const raw = latRes.rows[0]?.p99_ms;
		if (raw !== null && raw !== undefined) latencyP99 = parseFloat(raw);
	} catch {
		// trace_span may not have data yet; treat as null
	}

	// 3. Error rate from trace_span (last error_window_s)
	let errorRatePct: number | null = null;
	try {
		const errRes = await query<{ total: string; errors: string }>(
			`SELECT
			   COUNT(*) AS total,
			   COUNT(*) FILTER (WHERE status = 'error') AS errors
			 FROM roadmap.trace_span
			 WHERE operation = 'mcp_tool_call'
			   AND started_at > now() - ($1 * interval '1 second')`,
			[t.error_window_s],
		);
		const total = parseInt(errRes.rows[0]?.total ?? "0", 10);
		const errors = parseInt(errRes.rows[0]?.errors ?? "0", 10);
		if (total > 0) errorRatePct = (errors / total) * 100;
	} catch {
		// no data
	}

	// 4. Fleet agent health
	let healthyAgents = 0;
	let totalAgents = 0;
	let staleAgentPct = 0;
	try {
		const fleetRes = await query<{ status: string; cnt: string }>(
			`SELECT status, COUNT(*) AS cnt
			 FROM roadmap_workforce.agent_health
			 GROUP BY status`,
		);
		for (const row of fleetRes.rows) {
			const cnt = parseInt(row.cnt, 10);
			totalAgents += cnt;
			if (row.status === "healthy") healthyAgents += cnt;
		}
		if (totalAgents > 0) staleAgentPct = ((totalAgents - healthyAgents) / totalAgents) * 100;
	} catch {
		// fleet table may be empty or inaccessible
	}

	// 5. Active leases
	let activeLeases = 0;
	try {
		const leaseRes = await query<{ cnt: string }>(
			"SELECT COUNT(*) AS cnt FROM roadmap.proposal_lease WHERE released_at IS NULL AND expires_at > now()",
		);
		activeLeases = parseInt(leaseRes.rows[0]?.cnt ?? "0", 10);
	} catch {
		// table access error
	}

	// 6. Derive SLA state
	const latencyBreach = latencyP99 !== null && latencyP99 > t.latency_p99_ms;
	const errorBreach = errorRatePct !== null && errorRatePct > t.error_rate_pct;
	const fleetBreach = totalAgents > 0 && staleAgentPct > t.stale_agent_pct;

	let state: SlaState = "Normal";
	if (latencyBreach || errorBreach || fleetBreach) {
		state = "Degraded";
	}

	const metrics: SlaMetrics = {
		state,
		latency_p99_ms: latencyP99,
		error_rate_pct: errorRatePct !== null ? Math.round(errorRatePct * 10) / 10 : null,
		healthy_agents: healthyAgents,
		total_agents: totalAgents,
		stale_agent_pct: Math.round(staleAgentPct * 10) / 10,
		active_leases: activeLeases,
		postgres_ok: postgresOk,
		thresholds: { latency_p99_ms: t.latency_p99_ms, error_rate_pct: t.error_rate_pct, stale_agent_pct: t.stale_agent_pct },
		checked_at: new Date().toISOString(),
	};

	return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }] };
}
