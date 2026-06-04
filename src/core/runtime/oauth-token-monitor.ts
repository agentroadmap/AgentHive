/**
 * P1967: Claude Code OAuth Token Expiry Monitor & Rotation Signals
 *
 * Pure utility functions for monitoring CLAUDE_CODE_OAUTH_TOKEN lifecycle.
 * - computeExpiryDays: Check how many days until token expires
 * - checkOAuthTokenExpiry: Monitor token with warning threshold
 * - emitOAuthRotateSignal: Emit a structured rotation signal on 401 failures
 *
 * No daemon — these are called from spawn failure paths and periodic checks.
 * Logging is optional via deps parameter.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthTokenStatus {
	daysUntilExpiry: number;
	isExpiring: boolean;
	provisioned_at?: number; // Unix ms
	expires_at: number; // Unix ms
}

export interface OAuthRotateSignal {
	code: "OAUTH_TOKEN_ROTATE";
	reason: string;
	status_code?: number;
	occurred_at: number; // Unix ms
}

export interface LogDeps {
	warn?: (msg: string) => void;
	error?: (msg: string) => void;
}

// ─── Expiry Monitoring ─────────────────────────────────────────────────────────

/**
 * computeExpiryDays
 *
 * Given a provisioning timestamp, compute how many days until the
 * CLAUDE_CODE_OAUTH_TOKEN expires (365-day lifetime).
 *
 * @param provisioned_at_ms Unix milliseconds when token was provisioned
 * @returns daysUntilExpiry (negative = already expired)
 */
export function computeExpiryDays(provisioned_at_ms: number): number {
	const LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
	const expires_at_ms = provisioned_at_ms + LIFETIME_MS;
	const now_ms = Date.now();
	const remaining_ms = expires_at_ms - now_ms;
	const daysRemaining = remaining_ms / (24 * 60 * 60 * 1000);
	return Math.ceil(daysRemaining);
}

/**
 * checkOAuthTokenExpiry
 *
 * Compute token expiry status and emit a WARN log if within the warning threshold.
 * Default threshold is 30 days.
 *
 * @param provisioned_at_ms Unix ms when token was provisioned (from config/flag)
 * @param warn_days_threshold Default 30; emit WARN when expiry <= this
 * @param deps Optional logging functions (warn, error)
 * @returns Token status including expiry count and warning flag
 */
export function checkOAuthTokenExpiry(
	provisioned_at_ms: number,
	warn_days_threshold: number = 30,
	deps?: LogDeps,
): OAuthTokenStatus {
	const daysUntilExpiry = computeExpiryDays(provisioned_at_ms);
	const LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
	const expires_at = provisioned_at_ms + LIFETIME_MS;

	const isExpiring = daysUntilExpiry <= warn_days_threshold;

	if (isExpiring) {
		const warnFn = deps?.warn ?? ((m: string) => console.warn(m));
		warnFn(
			`[OAUTH_TOKEN_EXPIRING] CLAUDE_CODE_OAUTH_TOKEN expires in ${daysUntilExpiry} days (${new Date(
				expires_at,
			).toISOString()})`,
		);
	}

	return {
		daysUntilExpiry,
		isExpiring,
		provisioned_at: provisioned_at_ms,
		expires_at,
	};
}

// ─── Rotation Signals ──────────────────────────────────────────────────────────

/**
 * emitOAuthRotateSignal
 *
 * When a spawn fails with a 401 error, emit a structured rotation signal.
 * This can trigger out-of-band monitoring (alerts, PagerDuty, etc.).
 *
 * @param status_code The HTTP status code from the failure (e.g. 401)
 * @param reason Human-readable reason (e.g. "claude --print returned 401 UNAUTHORIZED")
 * @param deps Optional logging function (error)
 * @returns The signal object (for testing or logging)
 */
export function emitOAuthRotateSignal(
	status_code: number,
	reason: string,
	deps?: LogDeps,
): OAuthRotateSignal {
	const signal: OAuthRotateSignal = {
		code: "OAUTH_TOKEN_ROTATE",
		reason,
		status_code,
		occurred_at: Date.now(),
	};

	const errorFn = deps?.error ?? ((m: string) => console.error(m));
	errorFn(
		`[OAUTH_TOKEN_ROTATE] OAuth token rotation needed: ${reason} (status=${status_code}, at=${new Date(
			signal.occurred_at,
		).toISOString()})`,
	);

	return signal;
}
