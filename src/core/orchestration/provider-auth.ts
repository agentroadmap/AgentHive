/**
 * P1435-C3: Per-(OS-user, provider) Auth Model + Fail-Loud
 *
 * Credential resolution keyed by (agency identity -> OS user, provider).
 * On 401/403 auth failures, marks the provider auth as down via setProviderAuthDown().
 * The offer/claim eligibility path skips agencies with provider auth marked down.
 *
 * Distinct from quota cooldown (P1359):
 * - auth_down_until: auth credentials are missing/expired for this provider route
 * - cooldown_until: quota exhausted; provider is temporarily throttled
 *
 * Both use similar TTL-based mechanisms but represent different failure modes.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

export type QueryFn = (
	sql: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Mark a provider route's authentication as down due to a 401/403 error.
 * Logs the escalation and sets auth_down_until to 1 hour from now.
 *
 * AC-2: On 401/403, the liaison calls setProviderAuthDown() and writes an
 * escalation_log row with obstacle_type='PROVIDER_AUTH_DOWN'.
 *
 * @param agentIdentity - The agency identity that encountered the auth error
 * @param routeProvider - The route provider (e.g., 'anthropic', 'openai')
 * @param statusCode - HTTP status code (401 or 403)
 * @param errorDetail - Error message for resolution_note
 * @param queryFn - Injected for testing; defaults to live DB pool
 */
export async function setProviderAuthDown(
	agentIdentity: string,
	routeProvider: string,
	statusCode: number,
	errorDetail: string,
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	const cooldownDurationSeconds = 3600; // 1 hour default
	const escalatedTo = "operator"; // Auth failures require operator intervention to re-key

	try {
		// Begin transaction for atomic escalation log + cooldown write
		await queryFn("BEGIN ISOLATION LEVEL SERIALIZABLE");

		// Log the escalation
		await queryFn(
			`INSERT INTO roadmap.escalation_log
       (obstacle_type, agent_identity, escalated_to, resolution_note, severity)
       VALUES ($1, $2, $3, $4, $5)`,
			[
				"PROVIDER_AUTH_DOWN",
				agentIdentity,
				escalatedTo,
				`${statusCode} auth error from ${routeProvider}: ${errorDetail.slice(0, 200)}`,
				"critical",
			],
		);

		// Mark the provider route as having auth down for 1 hour
		// This affects offer/claim eligibility for ALL agencies using this provider
		await queryFn(
			`UPDATE roadmap.model_routes
       SET auth_down_until = NOW() + INTERVAL '1 hour'
       WHERE route_provider = $1
         AND (auth_down_until IS NULL OR auth_down_until < NOW())`,
			[routeProvider],
		);

		await queryFn("COMMIT");
	} catch (err) {
		await queryFn("ROLLBACK").catch(() => {
			/* swallow rollback errors */
		});
		throw err;
	}
}

/**
 * SQL filter for route eligibility: exclude routes with auth_down_until in future.
 * Parallel structure to cooldownFilterSql (layer 6) but for auth cooldown.
 *
 * Used in route resolution to skip providers marked as auth-down.
 *
 * AC-3: The offer/claim path uses authDownFilterSql to skip agencies whose
 * provider auth is marked down.
 */
export function authDownFilterSql(alias = "mr"): string {
	return `(${alias}.auth_down_until IS NULL OR ${alias}.auth_down_until <= NOW())`;
}

/**
 * Check if a provider route's authentication is currently marked as down.
 * Returns true if auth_down_until is in the future.
 *
 * Used for pre-claim eligibility checks (AC-5).
 *
 * @param routeProvider - The route provider to check
 * @param queryFn - Injected for testing; defaults to live DB pool
 * @returns true if provider auth is down, false otherwise
 */
export async function isProviderAuthDown(
	routeProvider: string,
	queryFn: QueryFn = defaultQuery,
): Promise<boolean> {
	const { rows } = await queryFn(
		`SELECT EXISTS(
       SELECT 1 FROM roadmap.model_routes
       WHERE route_provider = $1
         AND auth_down_until IS NOT NULL
         AND auth_down_until > NOW()
       LIMIT 1
     ) AS is_down`,
		[routeProvider],
	);

	return (rows[0] as { is_down: boolean }).is_down;
}

/**
 * Clear a provider's auth-down status (operator action).
 * Sets auth_down_until to NULL, marking auth as active again.
 *
 * @param routeProvider - The route provider to clear
 * @param queryFn - Injected for testing; defaults to live DB pool
 */
export async function clearProviderAuthDown(
	routeProvider: string,
	queryFn: QueryFn = defaultQuery,
): Promise<void> {
	await queryFn(
		`UPDATE roadmap.model_routes
     SET auth_down_until = NULL
     WHERE route_provider = $1`,
		[routeProvider],
	);
}
