/**
 * P1359: MCP action handlers for provider/model cooldown management.
 * Exported to consolidated.ts opsRoutes for routing.
 */

import { query } from "../../../../infra/postgres/pool.ts";

interface CooldownStatusRow {
	route_provider: string;
	model_name: string;
	cooldown_until: string | null;
	priority: number;
	is_enabled: boolean;
}

interface ProviderHealthRow {
	provider_name: string;
	status: string;
	last_error_at: string | null;
	last_error_msg: string | null;
	error_count: number;
	cooldown_until: string | null;
}

/**
 * P1359 Action: cooldown_status
 * Lists active model-level and provider-level cooldowns.
 * Params:
 *   provider?: string  — filter by route provider (optional)
 *   only_active?: bool — only show active cooldowns (default: true)
 */
export async function cooldownStatus(
	params: Record<string, unknown>,
): Promise<{ model_routes: CooldownStatusRow[]; provider_health: ProviderHealthRow[] }> {
	const provider = params.provider as string | undefined;
	const onlyActive = params.only_active !== false; // default true

	// Query model_routes cooldowns
	let modelQuery = `SELECT route_provider, model_name, cooldown_until, priority, is_enabled
	                   FROM roadmap.model_routes`;
	const modelBinds: unknown[] = [];

	if (onlyActive) {
		modelQuery += ` WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()`;
	}
	if (provider) {
		modelQuery += onlyActive ? ` AND` : ` WHERE`;
		modelQuery += ` route_provider = $${modelBinds.length + 1}`;
		modelBinds.push(provider);
	}
	modelQuery += ` ORDER BY route_provider, priority DESC, model_name`;

	const { rows: modelRows } = await query<CooldownStatusRow>(modelQuery, modelBinds);

	// Query provider_health cooldowns
	let providerQuery = `SELECT provider_name, status, last_error_at, last_error_msg, error_count, cooldown_until
	                      FROM roadmap.provider_health`;
	const providerBinds: unknown[] = [];

	if (onlyActive) {
		providerQuery += ` WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()`;
	}
	if (provider) {
		providerQuery += onlyActive ? ` AND` : ` WHERE`;
		providerQuery += ` provider_name = $${providerBinds.length + 1}`;
		providerBinds.push(provider);
	}
	providerQuery += ` ORDER BY provider_name`;

	const { rows: providerRows } = await query<ProviderHealthRow>(providerQuery, providerBinds);

	return {
		model_routes: modelRows,
		provider_health: providerRows,
	};
}

/**
 * P1359 Action: cooldown_clear
 * Clears cooldown_until (sets to NULL) for a specific model route.
 * Params:
 *   provider: string  — route provider name (required)
 *   model: string     — model name (required)
 */
export async function cooldownClear(
	params: Record<string, unknown>,
): Promise<{ cleared: boolean; rows_affected: number }> {
	const provider = params.provider as string;
	const model = params.model as string;

	if (!provider || !model) {
		throw new Error("cooldown_clear requires both 'provider' and 'model' parameters");
	}

	const { rowCount } = await query(
		`UPDATE roadmap.model_routes
		 SET cooldown_until = NULL
		 WHERE route_provider = $1 AND model_name = $2`,
		[provider, model],
	);

	// Audit log entry
	await query(
		`INSERT INTO roadmap.audit_log (action, details)
		 VALUES ('cooldown_clear', $1)`,
		[JSON.stringify({ provider, model, timestamp: new Date().toISOString() })],
	).catch(() => {
		/* non-fatal */
	});

	return {
		cleared: (rowCount ?? 0) > 0,
		rows_affected: rowCount ?? 0,
	};
}

/**
 * P1359 Action: provider_cooldown_clear
 * Clears cooldown_until on provider_health for a specific provider.
 * Params:
 *   provider: string  — provider name (required)
 */
export async function providerCooldownClear(
	params: Record<string, unknown>,
): Promise<{ cleared: boolean; rows_affected: number }> {
	const provider = params.provider as string;

	if (!provider) {
		throw new Error("provider_cooldown_clear requires 'provider' parameter");
	}

	const { rowCount } = await query(
		`UPDATE roadmap.provider_health
		 SET cooldown_until = NULL
		 WHERE provider_name = $1`,
		[provider],
	);

	// Audit log entry
	await query(
		`INSERT INTO roadmap.audit_log (action, details)
		 VALUES ('provider_cooldown_clear', $1)`,
		[JSON.stringify({ provider, timestamp: new Date().toISOString() })],
	).catch(() => {
		/* non-fatal */
	});

	return {
		cleared: (rowCount ?? 0) > 0,
		rows_affected: rowCount ?? 0,
	};
}
