/**
 * P3795 AC-1: Unit tests for routing-gate.ts
 *
 * Covers all five gate branches:
 *   absent   → allowed=true, reason='unknown'
 *   stale    → allowed=true, reason='stale'
 *   ok       → allowed=true, reason='healthy'
 *   timeout  → allowed=false, reason='unhealthy'
 *   error    → allowed=false, reason='unhealthy'
 *
 * And the gate_disabled flag bypass path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HealthEntry } from "../cache.ts";
import { DEFAULT_PROVIDER_HEALTH_TTL_MS } from "../cache.ts";

// Mock runtimeConfig so the flag can be controlled in tests without a DB.
vi.mock("../../../shared/runtime/config.ts", () => ({
	get: vi.fn(),
}));

import * as runtimeConfig from "../../../shared/runtime/config.ts";
import { isProviderHealthyForDispatch } from "../routing-gate.ts";

const mockGet = vi.mocked(runtimeConfig.get);

function makeFreshEntry(status: HealthEntry["status"]): HealthEntry {
	return { status, checkedAt: Date.now() };
}

function makeStaleEntry(status: HealthEntry["status"]): HealthEntry {
	// checkedAt in the past beyond the TTL
	return { status, checkedAt: Date.now() - DEFAULT_PROVIDER_HEALTH_TTL_MS - 1_000 };
}

describe("isProviderHealthyForDispatch", () => {
	beforeEach(() => {
		// Default: gate is enabled
		mockGet.mockResolvedValue(true);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("absent cache entry → allowed=true, reason='unknown'", async () => {
		const getCachedEntry = () => null;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("unknown");
	});

	it("stale cache entry → allowed=true, reason='stale'", async () => {
		const entry = makeStaleEntry("error");
		const getCachedEntry = () => entry;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("stale");
		expect(result.checkedAt).toBe(entry.checkedAt);
	});

	it("fresh entry status='ok' → allowed=true, reason='healthy'", async () => {
		const entry = makeFreshEntry("ok");
		const getCachedEntry = () => entry;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("healthy");
		expect(result.status).toBe("ok");
		expect(result.checkedAt).toBe(entry.checkedAt);
	});

	it("fresh entry status='timeout' → allowed=false, reason='unhealthy'", async () => {
		const entry = makeFreshEntry("timeout");
		const getCachedEntry = () => entry;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("timeout");
		expect(result.checkedAt).toBe(entry.checkedAt);
	});

	it("fresh entry status='error' → allowed=false, reason='unhealthy'", async () => {
		const entry = makeFreshEntry("error");
		const getCachedEntry = () => entry;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
		expect(result.status).toBe("error");
	});

	it("gate_disabled flag → allowed=true, reason='gate_disabled' (no cache consulted)", async () => {
		mockGet.mockResolvedValue(false);
		// Even if entry is error, gate disabled means pass-through
		const entry = makeFreshEntry("error");
		const getCachedEntry = vi.fn(() => entry);
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		expect(result.allowed).toBe(true);
		expect(result.reason).toBe("gate_disabled");
		expect(getCachedEntry).not.toHaveBeenCalled();
	});

	it("gate flag read throws → defaults to enabled (gate ON)", async () => {
		mockGet.mockRejectedValue(new Error("DB unavailable"));
		const entry = makeFreshEntry("error");
		const getCachedEntry = () => entry;
		const result = await isProviderHealthyForDispatch("claude", null, { getCachedEntry });
		// Gate defaults ON when flag read fails
		expect(result.allowed).toBe(false);
		expect(result.reason).toBe("unhealthy");
	});
});
