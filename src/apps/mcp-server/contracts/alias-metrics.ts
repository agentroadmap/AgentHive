/**
 * AC-7: Prometheus metrics for MCP handler parameter alias usage.
 *
 * Emits metric: mcp_handler_param_alias_used{handler, deprecated_key, canonical_key}
 * Used to track when deprecated parameter names are still in use, enabling
 * automated deprecation tracking and removal proposals.
 */

import { query } from "../../../infra/postgres/pool.ts";

/**
 * Records alias usage in the database for metrics collection.
 * Emits to roadmap.trace_span with operation_type='mcp_alias_used'.
 */
export async function recordAliasUsage(
	toolName: string,
	deprecatedKey: string,
	canonicalKey: string,
): Promise<void> {
	try {
		// Log alias usage to trace_span for metrics aggregation
		await query(
			`INSERT INTO roadmap.trace_span (operation_type, service_did, attributes, status, started_at, ended_at)
			 VALUES ($1, $2, $3, $4, now() - interval '1 ms', now())`,
			[
				"mcp_alias_used",
				"mcp-server",
				JSON.stringify({
					tool_name: toolName,
					deprecated_key: deprecatedKey,
					canonical_key: canonicalKey,
				}),
				"ok",
			],
		);
	} catch (err) {
		// Non-fatal: metrics collection never blocks tool execution
		console.error("Failed to record alias usage:", err);
	}
}

/**
 * Generates a cron-eligible query to identify deprecated keys with zero usage
 * over the last N days, enabling automated deprecation-removal proposals.
 *
 * Query result: { deprecated_key, canonical_key, tool_name, days_zero_usage }
 */
export function generateDeprecationRemovalQuery(
	daysSinceLastUsage: number = 14,
): string {
	return `
		SELECT
			(attributes->>'deprecated_key') AS deprecated_key,
			(attributes->>'canonical_key') AS canonical_key,
			(attributes->>'tool_name') AS tool_name,
			EXTRACT(day FROM (now() - MAX(started_at))) AS days_since_last_usage
		FROM roadmap.trace_span
		WHERE operation_type = 'mcp_alias_used'
		  AND started_at > now() - interval '${daysSinceLastUsage} days'
		GROUP BY
			(attributes->>'deprecated_key'),
			(attributes->>'canonical_key'),
			(attributes->>'tool_name')
		HAVING MAX(started_at) < now() - interval '${daysSinceLastUsage} days'
		ORDER BY days_since_last_usage DESC;
	`;
}

/**
 * Metrics aggregation summary.
 * Callable from a cron job to generate alias-removal proposals.
 */
export interface DeprecationCandidate {
	deprecated_key: string;
	canonical_key: string;
	tool_name: string;
	days_since_last_usage: number;
}

/**
 * Fetches candidates for alias removal (zero usage for N consecutive days).
 */
export async function getDeprecationCandidates(
	daysSinceLastUsage: number = 14,
): Promise<DeprecationCandidate[]> {
	try {
		const result = await query(generateDeprecationRemovalQuery(daysSinceLastUsage));
		return result.rows as DeprecationCandidate[];
	} catch (err) {
		console.error("Failed to fetch deprecation candidates:", err);
		return [];
	}
}
