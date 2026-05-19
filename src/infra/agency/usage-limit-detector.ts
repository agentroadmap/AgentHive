/**
 * usage-limit-detector — pure function that scans spawn output for known
 * provider usage-limit / rate-limit signals.
 *
 * When a provider hits a usage cap, the orchestrator otherwise keeps
 * dispatching to the same agency, burning offer slots and the global
 * in-flight budget on doomed retries. This detector lets the liaison short-
 * circuit the next claim and pause the agency until the limit resets.
 *
 * Patterns are conservative: false positives (pausing for 24h when the
 * provider was actually fine) are recoverable by clearing
 * `roadmap.agency.metadata.paused_until`. False negatives (failing to detect
 * a real limit) just keep us in the existing burn-on-fail behavior, no worse.
 *
 * Decision rule (per operator policy, 2026-05-13):
 *   resetSeconds <= 7200  → "short window" — throttle the route only;
 *                            same agency keeps the offer; reaper will replay.
 *   resetSeconds  > 7200
 *     OR resetSeconds is null (unknown) → "long window" — throttle the
 *                            route AND pause this agency in DB so other
 *                            unpaused agencies can pick up the requeued offer.
 */

export type UsageLimitProvider = "openai" | "anthropic" | "google" | "github";

export interface UsageLimitSignal {
	/** Canonical route_provider value to throttle (matches model_routes.route_provider). */
	provider: UsageLimitProvider;
	/** Model identifier matching model_routes.model_name. */
	model: string;
	/**
	 * Reset moment if the message includes one we can parse. null when the
	 * message says "limit hit" but doesn't tell us when it clears — caller
	 * should treat as long-window.
	 */
	resetAt: Date | null;
	/** Short reason for the throttle row + log line. */
	reason: string;
	/** Raw line that matched, trimmed for log/audit use. */
	matchedLine: string;
}

/** ≤ 2 hours = "short window"; same agency keeps the offer. */
export const SHORT_WINDOW_SECONDS = 2 * 3600;

/**
 * For unknown or unparseable reset times, default to a 24h pause. Long enough
 * to outlast a daily reset, short enough that a stuck pause is self-healing
 * by tomorrow.
 */
export const UNKNOWN_RESET_FALLBACK_SECONDS = 24 * 3600;

interface DetectorInput {
	stdout?: string | null;
	stderr?: string | null;
	errorMessage?: string | null;
	/** route.routeProvider used for the spawn — used to fall back when the message doesn't name a provider. */
	defaultProvider?: UsageLimitProvider | string;
	/** route.modelName used for the spawn — used for throttle row's model column. */
	defaultModel?: string | null;
}

/**
 * Try to extract a usage-limit signal from spawn output. Returns null when
 * no pattern matches.
 */
export function detectUsageLimit(input: DetectorInput): UsageLimitSignal | null {
	const haystack = [input.stdout ?? "", input.stderr ?? "", input.errorMessage ?? ""].join(
		"\n",
	);
	if (!haystack.trim()) return null;

	// ── OpenAI Codex ─────────────────────────────────────────────────────────
	// Observed verbatim 1,229× on 2026-05-13:
	//   ERROR: You've hit your usage limit. Upgrade to Pro (...) try again at 3:21 PM.
	const codex = haystack.match(
		/(?:ERROR:\s*)?(?:You've|you've)\s+hit your usage limit[\s\S]*?try again at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:[AP]M)?)/i,
	);
	if (codex) {
		return {
			provider: "openai",
			model: input.defaultModel ?? "gpt-5.4",
			resetAt: parseClockTimeToFutureDate(codex[1]),
			reason: `codex_usage_limit: try again at ${codex[1]}`,
			matchedLine: codex[0].slice(0, 200),
		};
	}
	// Codex limit without a parseable time stamp.
	const codexNoTime = haystack.match(
		/(?:ERROR:\s*)?(?:You've|you've)\s+hit your usage limit/i,
	);
	if (codexNoTime) {
		return {
			provider: "openai",
			model: input.defaultModel ?? "gpt-5.4",
			resetAt: null,
			reason: "codex_usage_limit: no reset timestamp parsed",
			matchedLine: codexNoTime[0].slice(0, 200),
		};
	}

	// ── Anthropic / Claude Code ───────────────────────────────────────────────
	// Conservative match for any of: 5-hour limit message, "rate limit",
	// "credit", explicit Anthropic-style limit phrases. Treat as long-window
	// since the CLI rarely surfaces a parseable reset clock.
	if (
		/Claude AI usage limit reached|usage limit reached|rate[\s_-]?limit|429\b|credit[s]?\s+(exhausted|exceeded)/i.test(
			haystack,
		) &&
		(input.defaultProvider === "anthropic" || /claude/i.test(haystack))
	) {
		const m =
			haystack.match(/Claude AI usage limit reached[^\n]*/i) ??
			haystack.match(/[^\n]*(rate[\s_-]?limit|credit[s]?\s+exhausted)[^\n]*/i);
		return {
			provider: "anthropic",
			model: input.defaultModel ?? "claude-sonnet-4-6",
			resetAt: null,
			reason: "anthropic_usage_limit",
			matchedLine: m?.[0]?.slice(0, 200) ?? "anthropic limit",
		};
	}

	// ── Google / Gemini ──────────────────────────────────────────────────────
	if (
		/RESOURCE_EXHAUSTED|quota.{0,30}exceed|429\b/i.test(haystack) &&
		(input.defaultProvider === "google" || /gemini/i.test(haystack))
	) {
		const m =
			haystack.match(/[^\n]*(RESOURCE_EXHAUSTED|quota.{0,30}exceed)[^\n]*/i) ??
			haystack.match(/[^\n]*429[^\n]*/);
		return {
			provider: "google",
			model: input.defaultModel ?? "gemini-2.0-flash",
			resetAt: null,
			reason: "google_quota_exhausted",
			matchedLine: m?.[0]?.slice(0, 200) ?? "google quota",
		};
	}

	// ── GitHub Copilot ───────────────────────────────────────────────────────
	if (
		/Copilot.*(quota|limit)|monthly.{0,15}limit|allotment exhausted/i.test(haystack) &&
		(input.defaultProvider === "github" || /copilot/i.test(haystack))
	) {
		const m = haystack.match(
			/[^\n]*(Copilot.*(quota|limit)|monthly.{0,15}limit|allotment exhausted)[^\n]*/i,
		);
		return {
			provider: "github",
			model: input.defaultModel ?? "claude-sonnet-4-6",
			resetAt: null,
			reason: "copilot_usage_limit",
			matchedLine: m?.[0]?.slice(0, 200) ?? "copilot limit",
		};
	}

	return null;
}

/**
 * Parse a clock-time string like "3:21 PM", "15:21", or "9 AM" into the
 * NEXT future occurrence of that time in the system's local TZ. Codex
 * reports its reset clock in the user's local TZ (no offset given), so we
 * mirror that.
 */
export function parseClockTimeToFutureDate(
	clockStr: string,
	now: Date = new Date(),
): Date | null {
	const m = clockStr
		.trim()
		.match(/^([0-9]{1,2})(?::([0-9]{2}))?\s*([AP]M)?$/i);
	if (!m) return null;

	let hour = parseInt(m[1], 10);
	const minute = m[2] ? parseInt(m[2], 10) : 0;
	const ampm = m[3]?.toUpperCase();

	if (ampm === "PM" && hour < 12) hour += 12;
	else if (ampm === "AM" && hour === 12) hour = 0;

	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

	const candidate = new Date(now);
	candidate.setHours(hour, minute, 0, 0);
	// If the time has already passed today, the reset must be tomorrow.
	if (candidate.getTime() <= now.getTime()) {
		candidate.setDate(candidate.getDate() + 1);
	}
	return candidate;
}

/**
 * Compute seconds-until-reset for a signal, applying the unknown-fallback
 * when resetAt is null.
 */
export function resetSecondsForSignal(
	signal: UsageLimitSignal,
	now: Date = new Date(),
): number {
	if (signal.resetAt === null) return UNKNOWN_RESET_FALLBACK_SECONDS;
	const ms = signal.resetAt.getTime() - now.getTime();
	if (ms <= 0) return UNKNOWN_RESET_FALLBACK_SECONDS;
	return Math.ceil(ms / 1000);
}

/** True when this signal warrants pausing the agency (long-window). */
export function isLongWindow(
	signal: UsageLimitSignal,
	now: Date = new Date(),
): boolean {
	return resetSecondsForSignal(signal, now) > SHORT_WINDOW_SECONDS;
}
