/**
 * P3795 AC-6: Integration tests for provider health gate in the dispatch path.
 *
 * Tests the full gate → cache integration:
 *   (a) Cache marks provider as error → isProviderHealthyForDispatch blocks
 *   (b) Cache marks provider as ok → gate allows through
 *   (c) No cache entry → gate allows through (fail-open)
 *   (d) Two providers with different health — only the unhealthy one is blocked
 */
import { describe, it, expect, afterEach } from "bun:test";
import { setCached, clearCachedProviderHealth } from "../../provider-health/cache.ts";
import { isProviderHealthyForDispatch } from "../../provider-health/routing-gate.ts";

const PROVIDER_A = "test-provider-health-gate-claude";
const PROVIDER_B = "test-provider-health-gate-openai";

// Always enable gate via injected flag so tests don't depend on DB flag state
const gateOpts = { getFlagFn: () => true };

afterEach(() => {
	clearCachedProviderHealth();
});

describe("P3795 provider health gate — cache integration", () => {
	it("blocks dispatch when cache holds an error status for the provider", () => {
		setCached(PROVIDER_A, null, { status: "error", checkedAt: Date.now() });

		const result = isProviderHealthyForDispatch(PROVIDER_A, null, gateOpts);

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("error");
	});

	it("blocks dispatch when cache holds a timeout status for the provider", () => {
		setCached(PROVIDER_A, null, { status: "timeout", checkedAt: Date.now() });

		const result = isProviderHealthyForDispatch(PROVIDER_A, null, gateOpts);

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("timeout");
	});

	it("allows dispatch when cache holds ok status", () => {
		setCached(PROVIDER_B, null, { status: "ok", checkedAt: Date.now(), latencyMs: 50 });

		const result = isProviderHealthyForDispatch(PROVIDER_B, null, gateOpts);

		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("healthy");
	});

	it("allows dispatch (fail-open) when provider has no cache entry", () => {
		// No setCached call — cache is cold for this key
		const result = isProviderHealthyForDispatch("test-provider-cold-start", null, gateOpts);

		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("unknown");
	});

	it("two providers with different health — only the unhealthy one is blocked", () => {
		setCached(PROVIDER_A, null, { status: "error", checkedAt: Date.now() });
		setCached(PROVIDER_B, null, { status: "ok", checkedAt: Date.now() });

		const resultA = isProviderHealthyForDispatch(PROVIDER_A, null, gateOpts);
		const resultB = isProviderHealthyForDispatch(PROVIDER_B, null, gateOpts);

		expect(resultA.allowed).toBe(false);
		expect(resultB.allowed).toBe(true);
	});
});
