/**
 * P450 V1: CLI Builder Route Resolver
 *
 * Provides route-first model resolution with fallback audit logging.
 * When a CLI builder's defaultModel() is called, this module ensures
 * that an active route is attempted first, and emits an audit row
 * if no route is found.
 *
 * V1 behavior: defaultModel() stays, but wrapped with fallback metric.
 * V2 behavior: removal blocked until 24h zero fallback count.
 */

import { query } from "../../infra/postgres/pool.ts";

export interface ResolvedModelRoute {
	modelName: string;
	routeProvider: string;
	baseUrl: string;
	found: boolean;
}

/**
 * Attempt to resolve an active model route for the given CLI builder.
 * Falls back to hardcoded model if no route exists.
 * Emits audit row on fallback.
 */
export async function getRouteForBuilder(
	builder: string,
	intent?: string,
): Promise<ResolvedModelRoute> {
	try {
		// Query for an active route matching the builder (agent_cli column).
		const { rows } = await query<{
			model_name: string;
			route_provider: string;
			base_url: string;
		}>(
			`SELECT model_name, route_provider, base_url
       FROM roadmap.model_routes
       WHERE agent_cli = $1 AND is_enabled = true
       ORDER BY priority DESC, created_at DESC
       LIMIT 1`,
			[builder],
		);

		if (rows && rows.length > 0) {
			const row = rows[0];
			return {
				modelName: row.model_name,
				routeProvider: row.route_provider,
				baseUrl: row.base_url,
				found: true,
			};
		}

		// No route found; will emit fallback audit.
		return { modelName: "", routeProvider: "", baseUrl: "", found: false };
	} catch (err) {
		console.error(`[P450] Failed to query model_routes for builder "${builder}":`, err);
		return { modelName: "", routeProvider: "", baseUrl: "", found: false };
	}
}

/**
 * Emit a fallback audit row when defaultModel() is called because no route was found.
 * Used by each builder to track when they resort to hardcoded defaults.
 */
export async function emitCliBuilderFallback(
	builder: string,
	fallbackModel: string,
): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.cli_builder_fallback_audit
        (builder, fallback_model, called_at)
       VALUES ($1, $2, now())
       ON CONFLICT DO NOTHING`,
			[builder, fallbackModel],
		);
	} catch (err) {
		// Logging failure must not block the spawn.
		console.error(
			`[P450] Failed to emit cli_builder_fallback audit for builder "${builder}":`,
			err,
		);
	}
}
