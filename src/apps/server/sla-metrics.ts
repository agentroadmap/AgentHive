/**
 * P081: SLA Prometheus metrics module.
 *
 * Queries roadmap.trace_span at scrape time to produce Prometheus text format.
 * Stateless — all data lives in the database, not in-memory counters.
 * Serves both /metrics (Prometheus format) and /api/sla (JSON contract).
 */

import { query } from "../../infra/postgres/pool.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Registry, Histogram, Gauge } from "prom-client";

// Singleton registry — shared across scrapes within the process lifetime.
const register = new Registry();
register.setDefaultLabels({ service: "agenthive" });

const mcpCallDuration = new Histogram({
	name: "agenthive_mcp_call_duration_seconds",
	help: "MCP tool call latency histogram (seconds)",
	buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
	registers: [register],
});

const mcpErrorRate = new Gauge({
	name: "agenthive_mcp_error_rate",
	help: "MCP write error rate — 30-second rolling window (0-1)",
	registers: [register],
});

const availabilityGauge = new Gauge({
	name: "agenthive_availability_ratio",
	help: "Platform availability ratio — 30-day rolling (0-1)",
	registers: [register],
});

const slaStateGauge = new Gauge({
	name: "agenthive_sla_state",
	help: "Current platform SLA state: 0=Normal 1=Degraded 2=Down",
	registers: [register],
});

async function refreshMetrics(): Promise<void> {
	// Latency histogram — last 5 minutes of mcp_tool_call spans
	try {
		const lat = await query(`
			SELECT (attributes->>'duration_ms')::float AS duration_ms
			FROM roadmap.trace_span
			WHERE operation = 'mcp_tool_call'
			  AND started_at > now() - interval '5 minutes'
			LIMIT 1000
		`);
		mcpCallDuration.reset();
		for (const r of lat.rows) {
			if (r.duration_ms != null) {
				mcpCallDuration.observe(r.duration_ms / 1000);
			}
		}
	} catch {
		// Non-fatal — histogram stays empty
	}

	// Error rate — 30s window
	try {
		const err = await query(`
			SELECT
				count(*) FILTER (WHERE status = 'error') AS errors,
				count(*) AS total
			FROM roadmap.trace_span
			WHERE operation = 'mcp_tool_call'
			  AND started_at > now() - interval '30 seconds'
		`);
		const r = err.rows[0] ?? {};
		const total = parseInt(r.total ?? "0", 10);
		const errors = parseInt(r.errors ?? "0", 10);
		mcpErrorRate.set(total > 0 ? errors / total : 0);
	} catch {
		// Non-fatal
	}

	// 30-day availability — fraction of minutes without Down events
	try {
		const avail = await query(`
			SELECT
				COALESCE(
					1.0 - (
						SELECT sum(
							EXTRACT(EPOCH FROM (
								COALESCE(resolved_at, now()) - occurred_at
							)) / 60
						) / 43200.0
						FROM roadmap.sla_events
						WHERE state = 'Down'
						  AND occurred_at > now() - interval '30 days'
					), 1.0
				) AS ratio
		`);
		availabilityGauge.set(parseFloat(avail.rows[0]?.ratio ?? "1"));
	} catch {
		availabilityGauge.set(1);
	}

	// SLA state
	try {
		const st = await query(`
			SELECT state FROM roadmap.sla_events
			ORDER BY occurred_at DESC LIMIT 1
		`);
		const s = st.rows[0]?.state ?? "Normal";
		slaStateGauge.set(s === "Down" ? 2 : s === "Degraded" ? 1 : 0);
	} catch {
		slaStateGauge.set(0);
	}
}

export async function serveMetrics(): Promise<string> {
	await refreshMetrics();
	return register.metrics();
}

export function serveSlaContract(): Record<string, unknown> {
	try {
		const contractPath = resolve(process.cwd(), "docs/sla-contract.json");
		const raw = readFileSync(contractPath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return {
			schema: "agenthive-sla/v1",
			version: "1.0.0",
			error: "sla-contract.json not found — run P081 documentation step",
		};
	}
}
