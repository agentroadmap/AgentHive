/**
 * P1511: SLA monitoring and health check operator tools
 * Queries roadmap.trace_span and roadmap.sla_config to expose system health metrics via mcp_ops.
 * Monitors p99 latency, error rates, and compares against configured thresholds.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

export interface SlaThresholds {
	p99_latency_ms: number;
	error_rate_threshold_pct: number;
	error_rate_window_seconds: number;
}

export interface SlaMetrics {
	p99_ms: number | null;
	error_count: number;
	total_count: number;
	error_rate_pct: number;
}

export interface HealthCheckResult {
	state: "normal" | "degraded" | "down";
	metrics: SlaMetrics;
	thresholds: SlaThresholds;
	measured_at: string;
	details: string;
}

export interface SlaHealthResult {
	state: "normal" | "degraded" | "down";
	metrics: SlaMetrics;
	thresholds: SlaThresholds;
	measured_at: string;
	details: string;
	state_changed: boolean;
	previous_state?: "normal" | "degraded" | "down" | null;
}

export interface SlaConfigRow {
	id: number;
	p99_latency_ms: number;
	error_rate_threshold_pct: number;
	error_rate_window_seconds: number;
	created_at: string;
	updated_at: string;
}

export interface TraceSpanAggregateRow {
	p99_ms: number | null;
	error_count: number;
	total_count: number;
}

export interface SlaEventRow {
	id: number;
	state: "normal" | "degraded" | "down";
	previous_state: "normal" | "degraded" | "down" | null;
	trigger_metric: string | null;
	trigger_value: string | null;
	details: string | null;
	created_at: string;
}

export class SlaHandler {
	constructor(private pool: Pool) {}

	/**
	 * Query SLA configuration thresholds from observability schema.
	 * Returns the most recently updated config row.
	 * Falls back to sensible defaults if no config exists.
	 */
	private async getSlaConfig(): Promise<SlaThresholds> {
		try {
			const result = await this.pool.query<SlaConfigRow>(
				`SELECT
					id,
					p99_latency_ms,
					error_rate_threshold_pct,
					error_rate_window_seconds,
					created_at,
					updated_at
				FROM roadmap.sla_config
				ORDER BY updated_at DESC
				LIMIT 1`,
			);

			if (result.rows.length > 0) {
				const row = result.rows[0];
				return {
					p99_latency_ms: row.p99_latency_ms,
					error_rate_threshold_pct: row.error_rate_threshold_pct,
					error_rate_window_seconds: row.error_rate_window_seconds,
				};
			}
		} catch (err) {
			// Table or schema doesn't exist; fall through to defaults
			if (
				err instanceof Error &&
				err.message.includes("does not exist")
			) {
				// Silently fall through to defaults
			} else {
				// Log unexpected errors but continue with defaults
				console.error("[SLA] Unexpected error fetching sla_config:", err);
			}
		}

		// Default thresholds (sensible production values)
		return {
			p99_latency_ms: 1000, // 1 second
			error_rate_threshold_pct: 5.0, // 5%
			error_rate_window_seconds: 300, // 5 minutes
		};
	}

	/**
	 * Query roadmap.trace_span for mcp_tool_call operations in the last 5 minutes.
	 * Compute p99 latency, error count, and total count.
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
					AND created_at > now() - interval '5 minutes'`,
			);

			if (result.rows.length > 0) {
				const row = result.rows[0];
				const errorCount = Number(row.error_count) || 0;
				const totalCount = Number(row.total_count) || 0;
				const errorRatePct =
					totalCount > 0 ? (errorCount / totalCount) * 100 : 0;

				return {
					p99_ms: row.p99_ms ? Number(row.p99_ms) : null,
					error_count: errorCount,
					total_count: totalCount,
					error_rate_pct: Math.round(errorRatePct * 100) / 100,
				};
			}
		} catch (err) {
			// Table or schema doesn't exist; return zero metrics
			if (
				err instanceof Error &&
				err.message.includes("does not exist")
			) {
				// Silently continue with zero metrics
			} else {
				console.error("[SLA] Unexpected error querying trace_span:", err);
			}
		}

		// No data available
		return {
			p99_ms: null,
			error_count: 0,
			total_count: 0,
			error_rate_pct: 0,
		};
	}

	/**
	 * Determine system health state based on metrics vs thresholds.
	 * State transition logic:
	 * - 'down': p99_ms is null (no data) OR total_count=0
	 * - 'degraded': p99_ms >= threshold OR error_rate_pct >= error_rate_threshold_pct
	 * - 'normal': otherwise
	 */
	private computeState(
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
	): "normal" | "degraded" | "down" {
		// No data → down
		if (
			metrics.p99_ms === null ||
			metrics.total_count === 0
		) {
			return "down";
		}

		// Latency breach → degraded
		if (metrics.p99_ms >= thresholds.p99_latency_ms) {
			return "degraded";
		}

		// Error rate breach → degraded
		if (metrics.error_rate_pct >= thresholds.error_rate_threshold_pct) {
			return "degraded";
		}

		// All checks passed → normal
		return "normal";
	}

	/**
	 * Generate human-readable details about the health state.
	 */
	private generateDetails(
		state: "normal" | "degraded" | "down",
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
	): string {
		if (state === "down") {
			if (metrics.total_count === 0) {
				return "No trace data available in the last 5 minutes.";
			}
			return "System is down — no metrics collected.";
		}

		if (state === "degraded") {
			const issues: string[] = [];

			if (metrics.p99_ms !== null && metrics.p99_ms >= thresholds.p99_latency_ms) {
				issues.push(
					`p99 latency ${metrics.p99_ms}ms exceeds threshold ${thresholds.p99_latency_ms}ms`,
				);
			}

			if (metrics.error_rate_pct >= thresholds.error_rate_threshold_pct) {
				issues.push(
					`error rate ${metrics.error_rate_pct.toFixed(2)}% exceeds threshold ${thresholds.error_rate_threshold_pct}%`,
				);
			}

			return `System degraded: ${issues.join("; ")}`;
		}

		return `System healthy. p99=${metrics.p99_ms}ms (threshold ${thresholds.p99_latency_ms}ms), error_rate=${metrics.error_rate_pct.toFixed(2)}% (threshold ${thresholds.error_rate_threshold_pct}%)`;
	}

	/**
	 * Fetch the most recent SLA event state from roadmap.sla_events.
	 * Returns null if no events exist or if the table doesn't exist.
	 */
	private async getPreviousState(): Promise<("normal" | "degraded" | "down") | null> {
		try {
			const result = await this.pool.query<SlaEventRow>(
				`SELECT state, previous_state, created_at
				FROM roadmap.sla_events
				ORDER BY created_at DESC
				LIMIT 1`,
			);

			if (result.rows.length > 0) {
				return result.rows[0].state;
			}
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.includes("does not exist")
			) {
				// Table doesn't exist yet; return null
			} else {
				console.error("[SLA] Unexpected error fetching previous state:", err);
			}
		}

		return null;
	}

	/**
	 * Determine trigger metric and value based on what caused the state change.
	 */
	private determineTriggerMetric(
		newState: "normal" | "degraded" | "down",
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
	): { metric: string | null; value: string | null } {
		if (newState === "down") {
			if (metrics.total_count === 0) {
				return { metric: "total_count", value: "0" };
			}
			if (metrics.p99_ms === null) {
				return { metric: "p99_ms", value: null };
			}
			return { metric: "unknown", value: null };
		}

		if (newState === "degraded") {
			if (metrics.p99_ms !== null && metrics.p99_ms >= thresholds.p99_latency_ms) {
				return { metric: "p99_latency_ms", value: String(metrics.p99_ms) };
			}
			if (metrics.error_rate_pct >= thresholds.error_rate_threshold_pct) {
				return { metric: "error_rate_pct", value: String(metrics.error_rate_pct) };
			}
		}

		return { metric: null, value: null };
	}

	/**
	 * Record state transition in roadmap.sla_events and emit NOTIFY.
	 */
	private async recordStateTransition(
		newState: "normal" | "degraded" | "down",
		previousState: ("normal" | "degraded" | "down") | null,
		metrics: SlaMetrics,
		thresholds: SlaThresholds,
		details: string,
	): Promise<void> {
		try {
			const { metric: triggerMetric, value: triggerValue } =
				this.determineTriggerMetric(newState, metrics, thresholds);

			// INSERT into roadmap.sla_events
			await this.pool.query(
				`INSERT INTO roadmap.sla_events
					(state, previous_state, trigger_metric, trigger_value, details)
				VALUES ($1, $2, $3, $4, $5)`,
				[newState, previousState, triggerMetric, triggerValue, details],
			);

			// Emit NOTIFY with state change payload
			const notifyPayload = {
				type: "sla_state_change",
				state: newState,
				previous_state: previousState,
				metrics: {
					p99_ms: metrics.p99_ms,
					error_count: metrics.error_count,
					total_count: metrics.total_count,
					error_rate_pct: metrics.error_rate_pct,
				},
				triggered_at: new Date().toISOString(),
			};

			await this.pool.query(
				`SELECT pg_notify('roadmap_notify', $1)`,
				[JSON.stringify(notifyPayload)],
			);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.includes("does not exist")
			) {
				// Table doesn't exist yet; silently skip
				console.warn("[SLA] roadmap.sla_events table does not exist yet");
			} else {
				console.error("[SLA] Error recording state transition:", err);
			}
		}
	}

	/**
	 * Execute health check: fetch metrics and thresholds, compute state, return result.
	 * Also tracks state transitions and emits notifications.
	 */
	async healthCheck(): Promise<SlaHealthResult> {
		const [metrics, thresholds, previousState] = await Promise.all([
			this.getTraceMetrics(),
			this.getSlaConfig(),
			this.getPreviousState(),
		]);

		const state = this.computeState(metrics, thresholds);
		const details = this.generateDetails(state, metrics, thresholds);
		const measured_at = new Date().toISOString();

		// Check if state changed
		const stateChanged = state !== previousState;

		// If state changed, record the transition and notify
		if (stateChanged) {
			await this.recordStateTransition(
				state,
				previousState,
				metrics,
				thresholds,
				details,
			);
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

/**
 * Exported entry point for MCP ops tools.
 * Instantiates SlaHandler with the provided pool and executes a health check.
 */
export async function slaHealthCheck(pool: Pool): Promise<SlaHealthResult> {
	const handler = new SlaHandler(pool);
	return handler.healthCheck();
}
