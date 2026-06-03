/**
 * P908-B: Provider cooldown utilities — extracted from legacy-dispatch.ts.
 *
 * Classifies spawn outcomes from exit codes + stderr, and reads/writes
 * cooldown state to roadmap.provider_health. All SQL functions accept an
 * injectable `exec` for unit-testing.
 */
import { query } from "../../infra/postgres/pool.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

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

export function classifyProviderError(stderr: string): {
	type: "rate_limit" | "credit_exhausted";
	matched: string;
} | null {
	for (const pat of RATE_LIMIT_PATTERNS) {
		const m = stderr.match(pat);
		if (m) return { type: "rate_limit", matched: m[0] };
	}
	for (const pat of CREDIT_PATTERNS) {
		const m = stderr.match(pat);
		if (m) return { type: "credit_exhausted", matched: m[0] };
	}
	return null;
}

/**
 * Classify a spawn outcome from exit code and stderr.
 * "rate_limited" beats exit code — a process that exits non-zero due to
 * rate-limiting should trigger cooldown, not a generic failure.
 */
export function classifySpawnOutcome(
	exitCode: number | null,
	stderr: string,
): "rate_limited" | "delivered" | "failed" {
	const cls = classifyProviderError(stderr);
	if (cls?.type === "rate_limit") return "rate_limited";
	if (exitCode === 0 || exitCode === null) return "delivered";
	return "failed";
}

const defaultExec: SqlExec = (sql, params) => query(sql, params as unknown[]);

export async function isProviderInCooldown(
	provider: string,
	exec: SqlExec = defaultExec,
): Promise<boolean> {
	const result = (await exec(
		`SELECT (cooldown_until IS NOT NULL AND cooldown_until > now()) AS in_cooldown
       FROM roadmap.provider_health
       WHERE provider_name = $1`,
		[provider],
	)) as { rows: Array<{ in_cooldown: boolean }> };
	return result.rows[0]?.in_cooldown ?? false;
}

export async function setProviderCooldown(
	provider: string,
	errorType: "rate_limit" | "credit_exhausted",
	errorMsg: string,
	exec: SqlExec = defaultExec,
): Promise<void> {
	const cooldownMinutes = errorType === "rate_limit" ? 2 : 30;
	await exec(
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
		[
			provider,
			errorType === "rate_limit" ? "rate_limited" : "credit_exhausted",
			errorMsg.slice(0, 500),
		],
	);
}

export async function recordProviderSuccess(
	provider: string,
	exec: SqlExec = defaultExec,
): Promise<void> {
	await exec(
		`UPDATE roadmap.provider_health
        SET status = 'healthy', error_count = 0, cooldown_until = NULL,
            last_success_at = now(), updated_at = now()
      WHERE provider_name = $1`,
		[provider],
	);
}
