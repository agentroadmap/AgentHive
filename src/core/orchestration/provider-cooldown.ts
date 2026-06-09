/**
 * P908-B: Standalone provider cooldown module.
 *
 * Extracted from legacy-dispatch.ts so both the legacy direct-spawn path and
 * the new offer-dispatch path (offer-dispatch-handler.ts) can record and check
 * provider health without duplicating logic.
 */
import { query } from "../../infra/postgres/pool.ts";

const RATE_LIMIT_PATTERNS = [
	/rate.?limit/i,
	/429/,
	/too many requests/i,
	/throttle/i,
	/retry.?after/i,
	/rpm.?exceeded/i,
	/tpm.?exceeded/i,
];

const CREDIT_PATTERNS = [
	/credit/i,
	/insufficient.?funds/i,
	/billing/i,
	/quota.?exceeded/i,
	/usage.?limit/i,
	/budget.?exceeded/i,
];

// P2408: an unauthenticated worker CLI (e.g. `agy` with no OAuth token) prints a
// login prompt and exits 0 having done NO work. Left unclassified, the dispatch
// handler treats exit-0 as a delivery — a silent offer-sink that fakes
// "delivered" rows and starves healthy agencies. These patterns let us detect
// the auth failure, mark the run failed, and cool the provider down long enough
// that the floor stops re-draining offers into a broken worker.
const AUTH_REQUIRED_PATTERNS = [
	/authentication required/i,
	/please (?:visit|log ?in|sign ?in)/i,
	/visit the url to log ?in/i,
	/you are not logged ?in/i,
	/not authenticated/i,
	/login required/i,
	/please run\s+\S+\s+login/i,
	/run `?\S+ login`?/i,
];

export type ProviderSignal = "rate_limit" | "credit_exhausted" | "auth_required";

/**
 * Classify stderr/stdout text into a provider signal type.
 * Returns null when no known error pattern is detected.
 *
 * Order matters: auth_required is checked first because an unauthenticated CLI
 * often also emits incidental "usage"/"limit" wording that would otherwise be
 * misread as a transient credit signal (2-min backoff) rather than the
 * persistent config fault it is (30-min backoff).
 */
export function classifyProviderSignal(text: string): ProviderSignal | null {
	for (const pat of AUTH_REQUIRED_PATTERNS) {
		if (pat.test(text)) return "auth_required";
	}
	for (const pat of RATE_LIMIT_PATTERNS) {
		if (pat.test(text)) return "rate_limit";
	}
	for (const pat of CREDIT_PATTERNS) {
		if (pat.test(text)) return "credit_exhausted";
	}
	return null;
}

/**
 * Check if a provider is in cooldown. Returns true if provider should NOT be used.
 */
export async function isProviderInCooldown(provider: string): Promise<boolean> {
	const { rows } = await query<{ in_cooldown: boolean }>(
		`SELECT (cooldown_until IS NOT NULL AND cooldown_until > now()) AS in_cooldown
       FROM roadmap.provider_health
       WHERE provider_name = $1`,
		[provider],
	);
	return rows[0]?.in_cooldown ?? false;
}

/**
 * Set cooldown on a provider.
 *   rate_limit:       2 min backoff (transient)
 *   credit_exhausted: 30 min backoff
 *   auth_required:    30 min backoff (persistent config fault — long enough that
 *                     the floor stops re-draining offers into a broken worker;
 *                     it clears on the next successful run via recordProviderSuccess)
 */
const COOLDOWN_MINUTES: Record<ProviderSignal, number> = {
	rate_limit: 2,
	credit_exhausted: 30,
	auth_required: 30,
};

const HEALTH_STATUS: Record<ProviderSignal, string> = {
	rate_limit: "rate_limited",
	credit_exhausted: "credit_exhausted",
	auth_required: "auth_required",
};

export async function setProviderCooldown(
	provider: string,
	errorType: ProviderSignal,
	errorMsg: string,
): Promise<void> {
	const cooldownMinutes = COOLDOWN_MINUTES[errorType];
	await query(
		`INSERT INTO roadmap.provider_health
       (provider_name, status, last_error_at, last_error_msg, error_count, cooldown_until, updated_at)
     VALUES ($1, $2, now(), $3, 1, now() + interval '${cooldownMinutes} minutes', now())
     ON CONFLICT (provider_name) DO UPDATE SET
       status = EXCLUDED.status,
       last_error_at = now(),
       last_error_msg = EXCLUDED.last_error_msg,
       error_count = roadmap.provider_health.error_count + 1,
       cooldown_until = now() + interval '${cooldownMinutes} minutes',
       updated_at = now()`,
		[provider, HEALTH_STATUS[errorType], errorMsg.slice(0, 500)],
	);
}

/**
 * Record a successful run for a provider (resets error_count, clears cooldown).
 */
export async function recordProviderSuccess(provider: string): Promise<void> {
	await query(
		`UPDATE roadmap.provider_health
        SET status = 'healthy', error_count = 0, cooldown_until = NULL,
            last_success_at = now(), updated_at = now()
      WHERE provider_name = $1`,
		[provider],
	);
}

/**
 * Convenience: classify stderr/stdout and apply cooldown in one call.
 * Returns the detected signal, or null when no known pattern matched.
 * Used by the offer-dispatch-handler after spawn exits non-zero.
 */
export async function setCooldownFromSignal(
	provider: string,
	stderrText: string,
): Promise<ProviderSignal | null> {
	const signal = classifyProviderSignal(stderrText);
	if (signal) {
		await setProviderCooldown(provider, signal, stderrText);
	}
	return signal;
}

/**
 * P1359: Set cooldown on a specific model route (not just provider-level).
 * Atomically merges with existing cooldown using GREATEST to preserve longer windows.
 * Called by spawnWithRetry when a model-specific quota error is detected.
 */
export async function setModelCooldown(
	routeProvider: string,
	modelName: string,
	cooldownMinutes: number,
	reason: string,
): Promise<void> {
	await query(
		`UPDATE roadmap.model_routes
	     SET cooldown_until = GREATEST(COALESCE(cooldown_until, 'epoch'::timestamptz), NOW() + interval '${cooldownMinutes} minutes')
	     WHERE route_provider = $1 AND model_name = $2`,
		[routeProvider, modelName],
	);
}

/**
 * P1682: Cool every route sharing an agent CLI (e.g. all `claude` CLI routes that
 * share one OAuth/subscription account). A subscription usage-limit is account-wide,
 * so per-(provider,model) cooldown is too narrow — it would leave sibling claude
 * routes hot. GREATEST merge preserves any longer existing window. The route-policy
 * cooldown filter then excludes these routes until cooldown_until passes, which is
 * also the automatic wake: the resolver re-includes them on the next loop, no
 * operator trigger and no in-process timer.
 */
export async function setCliFamilyCooldown(
	agentCli: string,
	cooldownMinutes: number,
	reason: string,
): Promise<void> {
	await query(
		`UPDATE roadmap.model_routes
		     SET cooldown_until = GREATEST(COALESCE(cooldown_until, 'epoch'::timestamptz), NOW() + interval '${cooldownMinutes} minutes')
		     WHERE agent_cli = $1`,
		[agentCli],
	);
	void reason;
}

/**
 * P1359: Check if a specific model route is in active cooldown.
 */
export async function isModelInCooldown(
	routeProvider: string,
	modelName: string,
): Promise<boolean> {
	const { rows } = await query<{ in_cooldown: boolean }>(
		`SELECT (cooldown_until IS NOT NULL AND cooldown_until > NOW()) AS in_cooldown
	     FROM roadmap.model_routes
	     WHERE route_provider = $1 AND model_name = $2`,
		[routeProvider, modelName],
	);
	return rows[0]?.in_cooldown ?? false;
}

/**
 * P1365-AC9: Apply soft-throttle backoff to model_routes.cooldown_until.
 * When an agency enters soft-throttle state (headroom < 25%), apply a cooldown
 * proportional to the headroom level so the route is deprioritized until capacity recovers.
 * Uses GREATEST() to preserve longer existing windows from P1359 quota cooldowns.
 *
 * Headroom ranges map to cooldown windows:
 * - 20-25%: 30 seconds (gentle backoff)
 * - 10-20%: 2 minutes (moderate backoff)
 * - <10%: 5 minutes (aggressive backoff)
 */
export async function setSoftThrottleCooldown(
	routeProvider: string,
	modelName: string,
	headroomPct: number | null,
): Promise<void> {
	if (headroomPct === null || headroomPct === undefined || headroomPct >= 25) {
		// No throttle needed if headroom is healthy
		return;
	}

	// Map headroom ranges to cooldown windows
	let cooldownMinutes: number;
	if (headroomPct >= 20) {
		cooldownMinutes = 0.5; // 30 seconds
	} else if (headroomPct >= 10) {
		cooldownMinutes = 2; // 2 minutes
	} else {
		cooldownMinutes = 5; // 5 minutes
	}

	await query(
		`UPDATE roadmap.model_routes
	     SET cooldown_until = GREATEST(COALESCE(cooldown_until, 'epoch'::timestamptz), NOW() + interval '${cooldownMinutes} minutes')
	     WHERE route_provider = $1 AND model_name = $2`,
		[routeProvider, modelName],
	);
}
