/**
 * SLA health check handler for P081.
 *
 * Monitors system health via:
 * - P99 latency of mcp_tool_call spans (roadmap.trace_span)
 * - Error rate of mcp_tool_call operations
 * - Agent stale/offline/crashed status (roadmap_workforce.agent_health)
 *
 * Compares metrics against thresholds from roadmap.sla_config.
 * Emits SLA state changes (Normal/Degraded/Down) to sla_events table
 * and notifies via pg_notify to configured alert_channel.
 */

import { query } from "../../../../infra/postgres/pool.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type SlaConfig = {
	latency_p99_ms_threshold: number;
	error_rate_pct_threshold: number;
	error_window_seconds: number;
	latency_window_seconds: number;
	stale_agent_pct_threshold: number;
	alert_channel: string;
};

type HealthCheckResult = {
	state: "Normal" | "Degraded" | "Down";
	p99_ms: number | null;
	error_rate_pct: number;
	stale_agent_pct: number;
	sample_count: number;
	thresholds: {
		latency_p99_ms: number;
		error_rate_pct: number;
		stale_agent_pct: number;
	};
	last_checked_at: string;
	previous_state: string | null;
};

export class SlaHandler {
	async handleHealthCheck(args: {
		window_seconds?: number;
	}): Promise<CallToolResult> {
		try {
			// 1. Read thresholds from roadmap.sla_config
			const { rows: configRows } = await query<{
				key: string;
				value: string;
			}>(
				`SELECT key, value FROM roadmap.sla_config WHERE key = ANY($1::text[])`,
				[
					[
						"latency_p99_ms_threshold",
						"error_rate_pct_threshold",
						"error_window_seconds",
						"latency_window_seconds",
						"stale_agent_pct_threshold",
						"alert_channel",
					],
				],
			);

			const configMap = new Map(configRows.map((r) => [r.key, r.value]));

			const config: SlaConfig = {
				latency_p99_ms_threshold: parseFloat(
					configMap.get("latency_p99_ms_threshold") ?? "500",
				),
				error_rate_pct_threshold: parseFloat(
					configMap.get("error_rate_pct_threshold") ?? "10",
				),
				error_window_seconds: parseInt(
					configMap.get("error_window_seconds") ?? "30",
					10,
				),
				latency_window_seconds: args.window_seconds ?? parseInt(
					configMap.get("latency_window_seconds") ?? "300",
					10,
				),
				stale_agent_pct_threshold: parseFloat(
					configMap.get("stale_agent_pct_threshold") ?? "20",
				),
				alert_channel: configMap.get("alert_channel") ?? "platform.alerts",
			};

			// 2. Compute p99 latency from mcp_tool_call spans (parameterized window)
			const { rows: latencyRows } = await query<{
				p99_ms: string | null;
				sample_count: string;
			}>(
				`SELECT
				   percentile_cont(0.99) WITHIN GROUP (
				     ORDER BY EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
				   ) AS p99_ms,
				   count(*) AS sample_count
				 FROM roadmap.trace_span
				 WHERE operation = 'mcp_tool_call'
				   AND ended_at IS NOT NULL
				   AND started_at > NOW() - ($1 * INTERVAL '1 second')`,
				[config.latency_window_seconds],
			);

			const p99Ms = latencyRows[0]?.p99_ms != null
				? parseFloat(latencyRows[0].p99_ms)
				: null;
			const sampleCount = parseInt(latencyRows[0]?.sample_count ?? "0", 10);

			// 3. Error rate over the error window (parameterized)
			const { rows: errorRows } = await query<{
				total: string;
				errors: string;
			}>(
				`SELECT
				   count(*) AS total,
				   count(*) FILTER (WHERE status = 'error') AS errors
				 FROM roadmap.trace_span
				 WHERE operation = 'mcp_tool_call'
				   AND started_at > NOW() - ($1 * INTERVAL '1 second')`,
				[config.error_window_seconds],
			);

			const total = parseInt(errorRows[0]?.total ?? "0", 10);
			const errors = parseInt(errorRows[0]?.errors ?? "0", 10);
			const errorRatePct = total > 0 ? (errors / total) * 100 : 0;

			// 4. Stale agents from agent_health
			const { rows: agentRows } = await query<{
				stale_count: string;
				total_count: string;
			}>(
				`SELECT
				   count(*) FILTER (WHERE status IN ('stale', 'offline', 'crashed')) AS stale_count,
				   count(*) AS total_count
				 FROM roadmap_workforce.agent_health`,
				[],
			);

			const staleCount = parseInt(agentRows[0]?.stale_count ?? "0", 10);
			const totalAgents = parseInt(agentRows[0]?.total_count ?? "0", 10);
			const staleAgentPct = totalAgents > 0 ? (staleCount / totalAgents) * 100 : 0;

			// 5. Determine SLA state based on thresholds
			let state: "Normal" | "Degraded" | "Down";
			if (totalAgents === 0) {
				state = "Down";
			} else if (
				(p99Ms !== null && p99Ms > config.latency_p99_ms_threshold) ||
				errorRatePct > config.error_rate_pct_threshold ||
				staleAgentPct > config.stale_agent_pct_threshold
			) {
				state = "Degraded";
			} else {
				state = "Normal";
			}

			// 6. Get previous state
			const { rows: prevStateRows } = await query<{ state: string }>(
				`SELECT state FROM roadmap.sla_events ORDER BY occurred_at DESC LIMIT 1`,
				[],
			);

			const previousState = prevStateRows.length > 0 ? prevStateRows[0].state : null;

			// 7. On state change: INSERT into sla_events and notify
			if (previousState !== state) {
				const trigger =
					p99Ms !== null && p99Ms > config.latency_p99_ms_threshold
						? `latency_p99_ms:${p99Ms.toFixed(2)}`
						: errorRatePct > config.error_rate_pct_threshold
							? `error_rate_pct:${errorRatePct.toFixed(2)}`
							: staleAgentPct > config.stale_agent_pct_threshold
								? `stale_agent_pct:${staleAgentPct.toFixed(2)}`
								: "no_threshold_breach";

				const metricValue = p99Ms !== null ? p99Ms : errorRatePct;
				const threshold =
					p99Ms !== null
						? config.latency_p99_ms_threshold
						: config.error_rate_pct_threshold;

				await query(
					`INSERT INTO roadmap.sla_events (occurred_at, state, prev_state, trigger, metric_value, threshold)
	       VALUES (NOW(), $1, $2, $3, $4, $5)`,
					[state, previousState, trigger, metricValue, threshold],
				);

				// Emit notification
				const payload = {
					state,
					prev_state: previousState,
					trigger,
					p99_ms: p99Ms,
					error_rate_pct: parseFloat(errorRatePct.toFixed(2)),
					stale_agent_pct: parseFloat(staleAgentPct.toFixed(2)),
					timestamp: new Date().toISOString(),
				};

				await query(
					`SELECT pg_notify($1, $2)`,
					[config.alert_channel, JSON.stringify(payload)],
				);
			}

			// 8. Return health check result
			const result: HealthCheckResult = {
				state,
				p99_ms: p99Ms,
				error_rate_pct: parseFloat(errorRatePct.toFixed(2)),
				stale_agent_pct: parseFloat(staleAgentPct.toFixed(2)),
				sample_count: sampleCount,
				thresholds: {
					latency_p99_ms: config.latency_p99_ms_threshold,
					error_rate_pct: config.error_rate_pct_threshold,
					stale_agent_pct: config.stale_agent_pct_threshold,
				},
				last_checked_at: new Date().toISOString(),
				previous_state: previousState,
			};

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (err) {
			const errorMsg =
				err instanceof Error ? err.message : String(err);
			return {
				content: [
					{
						type: "text",
						text: `⚠️ Health check failed: ${errorMsg}`,
					},
				],
			};
		}
	}
}
