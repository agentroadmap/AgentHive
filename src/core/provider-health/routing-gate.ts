import { getCached, DEFAULT_PROVIDER_HEALTH_TTL_MS, isCacheStale } from "./cache.ts";
import type { HealthEntry, HealthStatus } from "./cache.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

export interface HealthGateOptions {
	/** When true (default), fail-open when cache entry is stale or absent. */
	failOpenOnStale?: boolean;
	/** Override for test injection. */
	getCachedEntry?: typeof getCached;
}

export interface HealthGateResult {
	allowed: boolean;
	reason: "healthy" | "unhealthy" | "stale" | "unknown" | "gate_disabled";
	status?: HealthStatus;
	checkedAt?: number;
}

async function isGateEnabled(): Promise<boolean> {
	try {
		return await runtimeConfig.get(FlagKeys.PROVIDER_HEALTH_GATE_ENABLED);
	} catch {
		return true;
	}
}

export async function isProviderHealthyForDispatch(
	provider: string,
	model: string | null | undefined,
	options?: HealthGateOptions,
): Promise<HealthGateResult> {
	const gateEnabled = await isGateEnabled();
	if (!gateEnabled) {
		return { allowed: true, reason: "gate_disabled" };
	}

	const getCachedEntry = options?.getCachedEntry ?? getCached;
	const entry: HealthEntry | null = getCachedEntry(provider, model);

	if (entry === null) {
		// No probe result yet for this provider — could be cold start or
		// probe cycle gap. Fail-open to preserve availability.
		return { allowed: true, reason: "unknown" };
	}

	// The getCached() call in cache.ts already returns null for stale entries
	// (it checks TTL internally). We reach here only with a fresh entry.
	// The isCacheStale guard below is for injected getCachedEntry overrides
	// (tests that bypass HealthCache.get's built-in TTL check).
	if (isCacheStale(entry, DEFAULT_PROVIDER_HEALTH_TTL_MS)) {
		return { allowed: true, reason: "stale", checkedAt: entry.checkedAt };
	}

	if (entry.status === "ok") {
		return { allowed: true, reason: "healthy", status: entry.status, checkedAt: entry.checkedAt };
	}

	// status is "timeout" or "error"
	return {
		allowed: false,
		reason: "unhealthy",
		status: entry.status,
		checkedAt: entry.checkedAt,
	};
}
