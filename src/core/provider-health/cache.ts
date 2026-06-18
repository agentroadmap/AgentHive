import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

export type HealthStatus = "ok" | "timeout" | "error";

export interface HealthEntry {
	status: HealthStatus;
	checkedAt: number;
	latencyMs?: number;
}

export const DEFAULT_PROVIDER_HEALTH_TTL_MS = 30_000;

export async function resolveProviderHealthTtlMs(): Promise<number> {
	try {
		return await runtimeConfig.get(FlagKeys.PROVIDER_HEALTH_TTL_MS);
	} catch {
		return DEFAULT_PROVIDER_HEALTH_TTL_MS;
	}
}

type Clock = () => number;

function normalizeModel(model?: string | null): string {
	return model?.trim() ? model.trim() : "*";
}

export function healthCacheKey(
	provider: string,
	model?: string | null,
): string {
	return `${provider.trim()}:${normalizeModel(model)}`;
}

export class HealthCache {
	private readonly entries = new Map<string, HealthEntry>();

	constructor(
		private readonly ttlMs = DEFAULT_PROVIDER_HEALTH_TTL_MS,
		private readonly now: Clock = () => Date.now(),
	) {}

	get(provider: string, model?: string | null): HealthEntry | null {
		const entry =
			this.entries.get(healthCacheKey(provider, model)) ??
			this.entries.get(healthCacheKey(provider));
		if (!entry || isCacheStale(entry, this.ttlMs, this.now)) {
			return null;
		}
		return entry;
	}

	/**
	 * Return the raw entry regardless of staleness (null only when truly absent).
	 * P3795: the routing gate must distinguish "no probe yet" (unknown) from
	 * "probe ran but is stale" — `get()` collapses both to null, so callers that
	 * care about that distinction use `peek()` and compute staleness themselves
	 * via {@link isCacheStale}.
	 */
	peek(provider: string, model?: string | null): HealthEntry | null {
		return (
			this.entries.get(healthCacheKey(provider, model)) ??
			this.entries.get(healthCacheKey(provider)) ??
			null
		);
	}

	set(
		provider: string,
		model: string | null | undefined,
		entry: HealthEntry,
	): void {
		this.entries.set(healthCacheKey(provider, model), entry);
	}

	clear(): void {
		this.entries.clear();
	}
}

const defaultCache = new HealthCache();

export function isCacheStale(
	entry: HealthEntry,
	ttlMs = DEFAULT_PROVIDER_HEALTH_TTL_MS,
	now: Clock = () => Date.now(),
): boolean {
	return now() - entry.checkedAt > ttlMs;
}

export function getCached(
	provider: string,
	model?: string | null,
): HealthEntry | null {
	return defaultCache.get(provider, model);
}

/**
 * Staleness-agnostic read of the shared cache (P3795). Returns the entry even
 * when stale; null only when no probe has ever populated it. The routing gate
 * uses this to tell `unknown` (absent) apart from `stale`.
 */
export function peekCached(
	provider: string,
	model?: string | null,
): HealthEntry | null {
	return defaultCache.peek(provider, model);
}

export function setCached(
	provider: string,
	model: string | null | undefined,
	entry: HealthEntry,
): void {
	defaultCache.set(provider, model, entry);
}

export function clearCachedProviderHealth(): void {
	defaultCache.clear();
}
