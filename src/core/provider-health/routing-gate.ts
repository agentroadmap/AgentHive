/**
 * P3795: Hard routing gate on provider health.
 *
 * Converts P796's soft-sort health signal into a hard dispatch gate.
 * The gate is fail-open: absent or stale cache entries allow dispatch
 * through, so a cold start or probe gap never blocks all dispatch.
 */
import { getCached, DEFAULT_PROVIDER_HEALTH_TTL_MS } from "./cache.ts";
import type { HealthEntry, HealthStatus } from "./cache.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

export type { HealthStatus };

export interface HealthGateOptions {
	/** When true, stale entries allow dispatch (default: true). */
	failOpenOnStale?: boolean;
	/** Override cache lookup for testing. */
	getCachedEntry?: typeof getCached;
	/** Override flag lookup for testing. */
	getFlagFn?: (key: { name: string }) => boolean;
}

export interface HealthGateResult {
	allowed: boolean;
	reason: "healthy" | "unhealthy" | "stale" | "unknown" | "gate_disabled";
	status?: HealthStatus;
	checkedAt?: number;
}

export function isProviderHealthyForDispatch(
	provider: string,
	model: string | null | undefined,
	options?: HealthGateOptions,
): HealthGateResult {
	const gateFlagEnabled = (() => {
		try {
			const flagFn = options?.getFlagFn ?? config.getFlag;
			return flagFn(FlagKeys.PROVIDER_HEALTH_GATE_ENABLED);
		} catch {
			return true;
		}
	})();

	if (!gateFlagEnabled) {
		return { allowed: true, reason: "gate_disabled" };
	}

	const lookup = options?.getCachedEntry ?? getCached;
	const entry: HealthEntry | null = lookup(provider, model);

	if (!entry) {
		return { allowed: true, reason: "unknown" };
	}

	const ageMs = Date.now() - entry.checkedAt;
	const isStale = ageMs > DEFAULT_PROVIDER_HEALTH_TTL_MS;
	const failOpenOnStale = options?.failOpenOnStale ?? true;

	if (isStale && failOpenOnStale) {
		return { allowed: true, reason: "stale", checkedAt: entry.checkedAt };
	}

	if (entry.status === "ok") {
		return { allowed: true, reason: "healthy", status: entry.status, checkedAt: entry.checkedAt };
	}

	return {
		allowed: false,
		reason: "unhealthy",
		status: entry.status,
		checkedAt: entry.checkedAt,
	};
}
