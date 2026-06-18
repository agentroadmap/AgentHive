/**
 * P3795: Hard routing gate on provider health.
 *
 * P796's async probe populates an in-process {@link HealthCache} (+ a
 * `roadmap.provider_health_log` row) but its signal was only ever used as a
 * soft sort hint — `softSortProviderHealthCandidates()` had zero callers and a
 * provider actively returning errors/timeouts could still be dispatched work.
 *
 * This module turns that advisory signal into a hard circuit-breaker consulted
 * at dispatch time. It gates EXCLUSIVELY on the P796 in-process cache; it does
 * NOT touch the P908-B `roadmap.provider_health` / `model_routes.cooldown_until`
 * enforcement (which already filters routing via SQL) — see AC-7.
 *
 * Fail-open policy: probe interval and TTL are both ~30s. A cold start (no probe
 * yet) or a transient gap in the probe cycle must never block ALL dispatch, so
 * the gate fails open when the cache entry is absent (`unknown`) or stale
 * (`stale`). Persistent failures are still caught by the P908-B cooldown path.
 */
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import {
	DEFAULT_PROVIDER_HEALTH_TTL_MS,
	type HealthEntry,
	type HealthStatus,
	isCacheStale,
	peekCached,
} from "./cache.ts";

export type HealthGateReason =
	| "healthy"
	| "unhealthy"
	| "stale"
	| "unknown"
	| "gate_disabled";

export interface HealthGateResult {
	/** When false, the dispatch path must NOT spawn for this provider. */
	allowed: boolean;
	reason: HealthGateReason;
	/** The cached probe status, when an entry was found. */
	status?: HealthStatus;
	/** `checkedAt` epoch-ms of the cached entry, when one was found. */
	checkedAt?: number;
}

export interface HealthGateOptions {
	/** Treat a stale (but present) entry as allowed. Default: true. */
	failOpenOnStale?: boolean;
	/**
	 * Staleness-agnostic cache reader. Defaults to {@link peekCached} so the
	 * gate can distinguish `unknown` (absent) from `stale` — `getCached` hides
	 * staleness behind null. Injected by unit tests.
	 */
	getCachedEntry?: (provider: string, model?: string | null) => HealthEntry | null;
	/**
	 * Override the `PROVIDER_HEALTH_GATE_ENABLED` runtime flag. When omitted the
	 * gate reads the flag from config (env > DB > default true). Unit tests pass
	 * this to avoid needing an initialized config resolver.
	 */
	enabled?: boolean;
	/** TTL used for the staleness check. Defaults to the cache TTL constant. */
	ttlMs?: number;
	/** Clock injection for deterministic staleness tests. */
	now?: () => number;
}

/**
 * Resolve the `PROVIDER_HEALTH_GATE_ENABLED` flag, failing safe to the flag's
 * own default (`true`) when config is unavailable.
 */
async function resolveGateEnabled(): Promise<boolean> {
	try {
		return await runtimeConfig.get(FlagKeys.PROVIDER_HEALTH_GATE_ENABLED);
	} catch {
		// Config resolver not initialized (e.g. early boot, tests). The flag is
		// envOverride:true, so honor the process env before falling back to the
		// flag's own default — this keeps the operator kill-switch working even
		// when the resolver is down.
		const env = process.env.PROVIDER_HEALTH_GATE_ENABLED?.trim().toLowerCase();
		if (env === "false" || env === "0") return false;
		if (env === "true" || env === "1") return true;
		return FlagKeys.PROVIDER_HEALTH_GATE_ENABLED.defaultValue;
	}
}

/**
 * Decide whether `provider` (optionally scoped to `model`) may receive a
 * dispatched offer right now, based on the P796 health cache.
 *
 * Async because it reads the `PROVIDER_HEALTH_GATE_ENABLED` runtime flag
 * (AC-4); pass `options.enabled` to bypass the flag read in tests.
 */
export async function isProviderHealthyForDispatch(
	provider: string,
	model?: string | null,
	options?: HealthGateOptions,
): Promise<HealthGateResult> {
	const enabled = options?.enabled ?? (await resolveGateEnabled());
	if (!enabled) {
		return { allowed: true, reason: "gate_disabled" };
	}

	const read = options?.getCachedEntry ?? peekCached;
	const entry = read(provider, model);
	if (!entry) {
		// No probe has populated the cache yet → fail open.
		return { allowed: true, reason: "unknown" };
	}

	const ttlMs = options?.ttlMs ?? DEFAULT_PROVIDER_HEALTH_TTL_MS;
	const stale = isCacheStale(entry, ttlMs, options?.now ?? (() => Date.now()));
	if (stale) {
		// Probe cycle may be lagging → fail open (unless explicitly disabled).
		const failOpen = options?.failOpenOnStale ?? true;
		return {
			allowed: failOpen,
			reason: "stale",
			status: entry.status,
			checkedAt: entry.checkedAt,
		};
	}

	if (entry.status === "ok") {
		return {
			allowed: true,
			reason: "healthy",
			status: entry.status,
			checkedAt: entry.checkedAt,
		};
	}

	// Fresh entry, status timeout|error → hard block.
	return {
		allowed: false,
		reason: "unhealthy",
		status: entry.status,
		checkedAt: entry.checkedAt,
	};
}
