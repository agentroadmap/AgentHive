/**
 * P081: SLA monitoring and health check operator tools
 * Queries roadmap.trace_span and roadmap.sla_config to expose system health metrics via mcp_ops.
 * Monitors p99 latency, error rates, and compares against configured thresholds.
 *
 * Live DB schema (as of migration 182):
 *   roadmap.sla_config: key (PK), value, description, updated_at
 *     keys: latency_p99_ms_threshold, error_rate_pct_threshold, error_window_seconds, ...
 *   roadmap.sla_events: id, occurred_at, state, prev_state, trigger, metric_value, threshold, resolved_at
 *     state/prev_state CHECK: 'Normal' | 'Degraded' | 'Down' (capitalized)
 *   roadmap.trace_span: span_id, trace_id, operation, service_did, started_at, ended_at, attributes, status
 *     service_did CHECK: ^(agent|agency|operator):
 */

import { Pool } from "pg";

export interface SlaThresholds {
	latency_p99_ms: number;
	error_rate_pct: number;
	error_window_seconds: number;
}

export interface SlaMetrics {
	p99_ms: number | null;
	error_count: number;
	total_count: number;
	error_rate_pct: number;
}

export type SlaState = "Normal" | "Degraded" | "Down";

export interface HealthCheckResult {
	state: SlaState;
	metrics: SlaMetrics;
	thresholds: SlaThresholds;
	measured_at: string;
	details: string;
}

export interface SlaHealthResult {
	state: SlaState;
	metrics: SlaMetrics;
	thresholds: SlaThresholds;
	measured_at: string;
	details: string;
	state_changed: boolean;
	previous_state: SlaState | null;
}

interface SlaConfigKv {
	key: string;
	value: string;
}

interface TraceSpanAggregateRow {
	p99_ms: string | null;
	error_count: string;
	total_count: string;
}

interface SlaEventRow {
	state: SlaState;
	prev_state: SlaState | null;
	occurred_at: string;
}

export class SlaHandler {
	constructor(private pool: Pool) {}

	/**
	 * Query SLA configuration thresholds from key-value store.
	 * Falls back to sensible defaults if config rows are absent.
	 */
	private async getSlaConfig(): Promise<SlaThresholds> {
		try {
			const result = await this.pool.query<SlaConfigKv>(
				`SELECT key, value FROM roadmap.sla_config
				 WHERE key IN ('latency_p99_ms_threshold', 'error_rate_pct_threshold', 'error_window_seconds')`,
			);

			const cfg: Record<string, number> = {};
			for (const row of result.rows) {
				cfg[row.key] = Number(row.value);
			}

			return {
				latency_p99_ms: cfg['latency_p99_ms_threshold'] ?? 500,
				error_rate_pct: cfg['error_rate_pct_threshold'] ?? 10,
				error_window_seconds: cfg['error_window_seconds'] ?? 30,
			};
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("does not exist"))) {
				console.error("[SLA] Unexpected error fetching sla_config:", err);
			}
		}

		return { latency_p99_ms: 500, error_rate_pct: 10, error_window_seconds: 30 };
	}

	/**
	 * Query roadmap.trace_span for mcp_tool_call operations in the last 5 minutes.
	 * Computes p99 latency, error count, and total count.
	 */
	private async getTraceMetrics(): Promise<SlaMetrics> {
		try {
			const result = await this.pool.query<TraceSpanAggregateRow>(
				`SELECT
					PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY (attributes->>'duration_ms')::numeric) AS p99_ms,
					COUNT(*) FILTER (WHERE status = 'error') AS error_count,
					COUNT(*) AS total_count
				FROM roadmap.trace_span
				WHERE operation = 'mcp_tool_call'
					AND started_at > now() - interval '5 minutes'`,
			);

			if (result.rows.length > 0) {
				const row = result.rows[0];
				const errorCount = Number(row.error_count) || 0;
				const totalCount = Number(row.total_count) || 0;
				const errorRatePct = totalCount > 0 ? (errorCount / totalCount) * 100 : 0;

				return {
					p99_ms: row.p99_ms != null ? Number(row.p99_ms) : null,
					error_count: errorCount,
					total_count: totalCount,
					error_rate_pct: Math.round(errorRatePct * 100) / 100,
				};
			}
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("does not exist"))) {
				console.error("[SLA] Unexpected error querying trace_span:", err);
			}
		}

		return { p99_ms: null, error_count: 0, total_count: 0, error_rate_pct: 0 };
	}

	/**
	 * Determine system health state.
	 * - Down: no data (p99_ms null or total_count=0)
	 * - Degraded: latency or error rate breaches threshold
	 * - Normal: all checks pass
	 */
	private computeState(metrics: SlaMetrics, thresholds: SlaThresholds): SlaState {
		if (metrics.p99_ms === null || metrics.total_count === 0) {
			return "Down";
		}
		if (metrics.p99_ms >= thresholds.latency_p99_ms) {
			return "Degraded";
		}
		if (metrics.error_rate_pct >= thresholds.error_rate_pct) {
			return "Degraded";
		}
		return "Normal";
	}

	private generateDetails(
		state: SlaState,
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
	): string {
		if (state === "Down") {
			return metrics.total_count === 0
				? "No trace data available in the last 5 minutes."
				: "System is down — no metrics collected.";
		}

		if (state === "Degraded") {
			const issues: string[] = [];
			if (metrics.p99_ms !== null && metrics.p99_ms >= thresholds.latency_p99_ms) {
				issues.push(`p99 latency ${metrics.p99_ms}ms exceeds threshold ${thresholds.latency_p99_ms}ms`);
			}
			if (metrics.error_rate_pct >= thresholds.error_rate_pct) {
				issues.push(`error rate ${metrics.error_rate_pct.toFixed(2)}% exceeds threshold ${thresholds.error_rate_pct}%`);
			}
			return `System degraded: ${issues.join("; ")}`;
		}

		return `System healthy. p99=${metrics.p99_ms}ms (threshold ${thresholds.latency_p99_ms}ms), error_rate=${metrics.error_rate_pct.toFixed(2)}% (threshold ${thresholds.error_rate_pct}%)`;
	}

	/** Fetch the most recent SLA event state from roadmap.sla_events. */
	private async getPreviousState(): Promise<SlaState | null> {
		try {
			const result = await this.pool.query<SlaEventRow>(
				`SELECT state, prev_state, occurred_at
				 FROM roadmap.sla_events
				 ORDER BY occurred_at DESC
				 LIMIT 1`,
			);
			if (result.rows.length > 0) {
				return result.rows[0].state;
			}
		} catch (err) {
			if (!(err instanceof Error && err.message.includes("does not exist"))) {
				console.error("[SLA] Unexpected error fetching previous state:", err);
			}
		}
		return null;
	}

	/**
	 * Record a state transition in roadmap.sla_events and emit pg_notify on platform.alerts.
	 * sla_events columns: state, prev_state, trigger, metric_value, threshold
	 */
	private async recordStateTransition(
		newState: SlaState,
		previousState: SlaState | null,
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
		details: string,
	): Promise<void> {
		try {
			let trigger = "state_change";
			let metricValue: number | null = null;
			let threshold: number | null = null;

			if (newState === "Down" && metrics.total_count === 0) {
				trigger = "no_trace_data";
			} else if (newState === "Degraded") {
				if (metrics.p99_ms !== null && metrics.p99_ms >= thresholds.latency_p99_ms) {
					trigger = "latency_breach";
					metricValue = metrics.p99_ms;
					threshold = thresholds.latency_p99_ms;
				} else {
					trigger = "error_rate_breach";
					metricValue = metrics.error_rate_pct;
					threshold = thresholds.error_rate_pct;
				}
			} else if (newState === "Normal") {
				trigger = "recovery";
			}

			await this.pool.query(
				`INSERT INTO roadmap.sla_events (state, prev_state, trigger, metric_value, threshold)
				 VALUES ($1, $2, $3, $4, $5)`,
				[newState, previousState, trigger, metricValue, threshold],
			);

			// Notify agents via the configured alert channel
			const notifyPayload = JSON.stringify({
				type: "sla_state_change",
				state: newState,
				previous_state: previousState,
				trigger,
				metrics: {
					p99_ms: metrics.p99_ms,
					error_count: metrics.error_count,
					total_count: metrics.total_count,
					error_rate_pct: metrics.error_rate_pct,
				},
				details,
				occurred_at: new Date().toISOString(),
			});

			await this.pool.query(`SELECT pg_notify('platform.alerts', $1)`, [notifyPayload]);
		} catch (err) {
			if (err instanceof Error && err.message.includes("does not exist")) {
				console.warn("[SLA] roadmap.sla_events table does not exist yet");
			} else {
				console.error("[SLA] Error recording state transition:", err);
			}
		}
	}

	/** Execute health check: fetch metrics, compute state, record transitions, return result. */
	async healthCheck(): Promise<SlaHealthResult> {
		const [metrics, thresholds, previousState] = await Promise.all([
			this.getTraceMetrics(),
			this.getSlaConfig(),
			this.getPreviousState(),
		]);

		const state = this.computeState(metrics, thresholds);
		const details = this.generateDetails(state, metrics, thresholds);
		const measured_at = new Date().toISOString();
		const stateChanged = state !== previousState;

		if (stateChanged) {
			await this.recordStateTransition(state, previousState, metrics, thresholds, details);
		}

		return {
			state,
			metrics,
			thresholds,
			measured_at,
			details,
			state_changed: stateChanged,
			previous_state: previousState,
		};
	}
}

/** Entry point for mcp_ops health_check action. */
export async function slaHealthCheck(pool: Pool): Promise<SlaHealthResult> {
	return new SlaHandler(pool).healthCheck();
}
