/**
 * P3795 AC-6: unit tests for isProviderHealthyForDispatch()
 *
 * All branches tested via injected options (no module mocking needed):
 *   - absent cache entry (unknown) → allowed
 *   - stale entry, failOpenOnStale=true → allowed
 *   - stale entry, failOpenOnStale=false → blocked
 *   - fresh "ok" → allowed
 *   - fresh "timeout" → blocked
 *   - fresh "error" → blocked
 *   - gate_disabled flag → allowed regardless of health
 *   - getFlagFn throws → gate defaults enabled → status error → blocked
 */
import { describe, it, expect } from "bun:test";
import { isProviderHealthyForDispatch } from "../routing-gate.ts";
import { DEFAULT_PROVIDER_HEALTH_TTL_MS } from "../cache.ts";

const NOW = 1_700_000_000_000;

// Stable clock so staleness tests are deterministic
const freshAt = (offsetMs: number) => NOW - offsetMs;

function gateEnabled() {
	return { getFlagFn: () => true };
}
function gateDisabled() {
	return { getFlagFn: () => false };
}

describe("isProviderHealthyForDispatch", () => {
	it("returns allowed=true (unknown) when no cache entry exists", () => {
		const result = isProviderHealthyForDispatch("claude", "claude-sonnet-4-5", {
			...gateEnabled(),
			getCachedEntry: () => null,
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("unknown");
	});

	it("returns allowed=true (stale) when entry is older than TTL and failOpenOnStale=true", () => {
		const result = isProviderHealthyForDispatch("claude", null, {
			...gateEnabled(),
			failOpenOnStale: true,
			getCachedEntry: () => ({
				status: "error",
				checkedAt: freshAt(DEFAULT_PROVIDER_HEALTH_TTL_MS + 1),
			}),
		});
		// Use real Date.now for staleness; just ensure the entry is stale
		// by seeding checkedAt = 0 (epoch — always stale)
		const staleResult = isProviderHealthyForDispatch("claude", null, {
			...gateEnabled(),
			failOpenOnStale: true,
			getCachedEntry: () => ({ status: "error", checkedAt: 0 }),
		});
		expect(staleResult.allowed).toBe(true);
		expect(staleResult.reason).toBe("stale");
	});

	it("returns allowed=false (unhealthy) when stale and failOpenOnStale=false", () => {
		const result = isProviderHealthyForDispatch("claude", null, {
			...gateEnabled(),
			failOpenOnStale: false,
			getCachedEntry: () => ({ status: "error", checkedAt: 0 }),
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("error");
	});

	it("returns allowed=true (healthy) for a fresh ok entry", () => {
		const result = isProviderHealthyForDispatch("claude", null, {
			...gateEnabled(),
			getCachedEntry: () => ({ status: "ok", checkedAt: Date.now() - 1000, latencyMs: 42 }),
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("healthy");
		expect(result.status).toBe("ok");
	});

	it("returns allowed=false (unhealthy) for a fresh timeout entry", () => {
		const result = isProviderHealthyForDispatch("openai", null, {
			...gateEnabled(),
			getCachedEntry: () => ({ status: "timeout", checkedAt: Date.now() - 1000 }),
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("timeout");
	});

	it("returns allowed=false (unhealthy) for a fresh error entry", () => {
		const result = isProviderHealthyForDispatch("openai", null, {
			...gateEnabled(),
			getCachedEntry: () => ({ status: "error", checkedAt: Date.now() - 1000 }),
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("error");
	});

	it("returns allowed=true (gate_disabled) when PROVIDER_HEALTH_GATE_ENABLED=false", () => {
		const result = isProviderHealthyForDispatch("openai", null, {
			...gateDisabled(),
			getCachedEntry: () => ({ status: "error", checkedAt: Date.now() - 1000 }),
		});
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("gate_disabled");
	});

	it("defaults gate to enabled (blocks) when getFlagFn throws", () => {
		const result = isProviderHealthyForDispatch("claude", null, {
			getFlagFn: () => { throw new Error("flag not found"); },
			getCachedEntry: () => ({ status: "error", checkedAt: Date.now() - 1000 }),
		});
		// getFlagFn throws → gate defaults enabled → error status → blocked
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
	});
});
