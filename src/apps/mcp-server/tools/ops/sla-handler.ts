/**
 * P081: SLA health_check handler.
 *
 * Queries roadmap.trace_span for real MCP tool call latency,
 * roadmap.sla_config for configurable thresholds,
 * roadmap.sla_events for current state history, and
 * roadmap_workforce.agent_health for active agent count.
 *
 * Never silently wrong: Postgres unreachable → { state: "Down", error: "postgres_unreachable" }.
 */

import { query } from "../../../../infra/postgres/pool.ts";

export interface SlaMetrics {
	p99_latency_ms: number | null;
	error_rate_30s: number | null;
	error_rate_5m: number | null;
	active_agents: number;
	sample_count_5m: number;
}

export interface SlaHealthResult {
	state: "Normal" | "Degraded" | "Down";
	sla_version: string;
	metrics: SlaMetrics;
	breached_slos: string[];
	since: string;
	thresholds: {
		p99_latency_target_ms: number;
		error_threshold_percent: number;
	};
	error?: string;
}

interface SlaConfig {
	p99_latency_target_ms: number;
	error_threshold_percent: number;
	degraded_error_window_seconds: number;
}

const SLA_DEFAULTS: SlaConfig = {
	p99_latency_target_ms: 500,
	error_threshold_percent: 10,
	degraded_error_window_seconds: 30,
};

async function loadSlaConfig(): Promise<SlaConfig> {
	try {
		const rows = await query(`SELECT key, value FROM roadmap.sla_config`);
		const cfg = { ...SLA_DEFAULTS };
		for (const r of rows.rows) {
			if (r.key === "p99_latency_target_ms") cfg.p99_latency_target_ms = parseFloat(r.value);
			if (r.key === "degraded_error_threshold_percent") cfg.error_threshold_percent = parseFloat(r.value);
			if (r.key === "degraded_error_window_seconds") cfg.degraded_error_window_seconds = parseFloat(r.value);
		}
		return cfg;
	} catch {
		return SLA_DEFAULTS;
	}
}

async function getActiveAgents(): Promise<number> {
	try {
		const r = await query(`
			SELECT count(*) AS cnt
			FROM roadmap_workforce.agent_health
			WHERE status = 'healthy' AND last_heartbeat_at > now() - interval '2 minutes'
		`);
		return parseInt(r.rows[0]?.cnt ?? "0", 10);
	} catch {
		return 0;
	}
}

async function getLastState(): Promise<{ state: string | null; occurred_at: Date | null }> {
	try {
		const r = await query(`
			SELECT state, occurred_at FROM roadmap.sla_events
			ORDER BY occurred_at DESC LIMIT 1
		`);
		return {
			state: r.rows[0]?.state ?? null,
			occurred_at: r.rows[0]?.occurred_at ?? null,
		};
	} catch {
		return { state: null, occurred_at: null };
	}
}

async function persistStateTransition(
	newState: string,
	prevState: string | null,
	trigger: string,
): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.sla_events (state, prev_state, trigger)
			 VALUES ($1, $2, $3)`,
			[newState, prevState, trigger],
		);
		await query(`SELECT pg_notify('sla_state_change', $1)`, [
			JSON.stringify({
				state: newState,
				prev_state: prevState,
				trigger,
				timestamp: new Date().toISOString(),
			}),
		]);
	} catch {
		// Best-effort; state tracking must not fail the health check call
	}
}

export class SlaHandler {
	async healthCheck(_args: Record<string, unknown>): Promise<SlaHealthResult> {
		try {
			const [cfg, activeAgents, lastEvent] = await Promise.all([
				loadSlaConfig(),
				getActiveAgents(),
				getLastState(),
			]);

			// p99 and error rate over last 5 minutes
			const latResult = await query(`
				SELECT
					percentile_cont(0.99) WITHIN GROUP (
						ORDER BY (attributes->>'duration_ms')::float
					) AS p99_ms,
					count(*) FILTER (WHERE status = 'error') AS error_count,
					count(*) AS total_count
				FROM roadmap.trace_span
				WHERE operation = 'mcp_tool_call'
				  AND started_at > now() - interval '5 minutes'
			`);
			const lr = latResult.rows[0] ?? {};
			const p99 = lr.p99_ms != null ? parseFloat(lr.p99_ms) : null;
			const totalCount = parseInt(lr.total_count ?? "0", 10);
			const errorCount5m = parseInt(lr.error_count ?? "0", 10);
			const errorRate5m = totalCount > 0 ? (errorCount5m / totalCount) * 100 : null;

			// Short-window error rate (30s) used for state transitions
			const shortResult = await query(`
				SELECT
					count(*) FILTER (WHERE status = 'error') AS error_count,
					count(*) AS total_count
				FROM roadmap.trace_span
				WHERE operation = 'mcp_tool_call'
				  AND started_at > now() - interval '30 seconds'
			`);
			const sr = shortResult.rows[0] ?? {};
			const shortTotal = parseInt(sr.total_count ?? "0", 10);
			const shortErrors = parseInt(sr.error_count ?? "0", 10);
			const errorRate30s = shortTotal > 0 ? (shortErrors / shortTotal) * 100 : null;

			const breachedSlos: string[] = [];
			if (p99 !== null && p99 > cfg.p99_latency_target_ms) {
				breachedSlos.push(
					`p99_latency: ${p99.toFixed(1)}ms > ${cfg.p99_latency_target_ms}ms`,
				);
			}
			if (errorRate30s !== null && errorRate30s > cfg.error_threshold_percent) {
				breachedSlos.push(
					`error_rate_30s: ${errorRate30s.toFixed(1)}% > ${cfg.error_threshold_percent}%`,
				);
			}

			const state: "Normal" | "Degraded" | "Down" =
				breachedSlos.length > 0 ? "Degraded" : "Normal";

			// Track state transitions
			let since: string;
			if (lastEvent.state !== state) {
				const trigger =
					breachedSlos.length > 0
						? breachedSlos.join("; ")
						: "all_slos_within_target";
				await persistStateTransition(state, lastEvent.state, trigger);
				since = new Date().toISOString();
			} else {
				since = lastEvent.occurred_at
					? lastEvent.occurred_at.toISOString()
					: new Date().toISOString();
			}

			return {
				state,
				sla_version: "1.0.0",
				metrics: {
					p99_latency_ms: p99 !== null ? Math.round(p99 * 10) / 10 : null,
					error_rate_30s:
						errorRate30s !== null ? Math.round(errorRate30s * 10) / 10 : null,
					error_rate_5m:
						errorRate5m !== null ? Math.round(errorRate5m * 10) / 10 : null,
					active_agents: activeAgents,
					sample_count_5m: totalCount,
				},
				breached_slos: breachedSlos,
				since,
				thresholds: {
					p99_latency_target_ms: cfg.p99_latency_target_ms,
					error_threshold_percent: cfg.error_threshold_percent,
				},
			};
		} catch (err) {
			return {
				state: "Down",
				sla_version: "1.0.0",
				metrics: {
					p99_latency_ms: null,
					error_rate_30s: null,
					error_rate_5m: null,
					active_agents: 0,
					sample_count_5m: 0,
				},
				breached_slos: ["postgres_unreachable"],
				since: new Date().toISOString(),
				thresholds: {
					p99_latency_target_ms: SLA_DEFAULTS.p99_latency_target_ms,
					error_threshold_percent: SLA_DEFAULTS.error_threshold_percent,
				},
				error: err instanceof Error ? err.message : "postgres_unreachable",
			};
		}
	}
}
