/**
 * P3795 AC-1: unit coverage for the provider-health routing gate.
 *
 * Pure logic — all five cache branches plus the gate_disabled bypass are driven
 * through injected options (enabled, getCachedEntry, now, ttlMs) so the tests
 * need no config resolver and no live cache.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_HEALTH_TTL_MS, type HealthEntry } from "../cache.ts";
import { isProviderHealthyForDispatch } from "../routing-gate.ts";

const NOW = 1_000_000_000_000;
const now = () => NOW;

function entry(
	status: HealthEntry["status"],
	ageMs: number,
): HealthEntry {
	return { status, checkedAt: NOW - ageMs };
}

describe("isProviderHealthyForDispatch (P3795 AC-1)", () => {
	it("absent cache entry → allowed, reason=unknown (fail-open)", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			getCachedEntry: () => null,
			now,
		});
		expect(res).toEqual({ allowed: true, reason: "unknown" });
	});

	it("stale entry → allowed, reason=stale (fail-open) even if last status was error", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			getCachedEntry: () => entry("error", DEFAULT_PROVIDER_HEALTH_TTL_MS + 5_000),
			now,
		});
		expect(res.allowed).toBe(true);
		expect(res.reason).toBe("stale");
		expect(res.status).toBe("error");
	});

	it("fresh ok → allowed, reason=healthy", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			getCachedEntry: () => entry("ok", 1_000),
			now,
		});
		expect(res.allowed).toBe(true);
		expect(res.reason).toBe("healthy");
		expect(res.status).toBe("ok");
	});

	it("fresh timeout → blocked, reason=unhealthy", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			getCachedEntry: () => entry("timeout", 1_000),
			now,
		});
		expect(res.allowed).toBe(false);
		expect(res.reason).toBe("unhealthy");
		expect(res.status).toBe("timeout");
	});

	it("fresh error → blocked, reason=unhealthy", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			getCachedEntry: () => entry("error", 1_000),
			now,
		});
		expect(res.allowed).toBe(false);
		expect(res.reason).toBe("unhealthy");
		expect(res.status).toBe("error");
	});

	it("gate disabled → allowed, reason=gate_disabled regardless of a fresh error entry", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: false,
			// Even a fresh error must not block when the gate is off.
			getCachedEntry: () => entry("error", 1_000),
			now,
		});
		expect(res).toEqual({ allowed: true, reason: "gate_disabled" });
	});

	it("failOpenOnStale=false → stale entry blocks", async () => {
		const res = await isProviderHealthyForDispatch("openai", null, {
			enabled: true,
			failOpenOnStale: false,
			getCachedEntry: () => entry("error", DEFAULT_PROVIDER_HEALTH_TTL_MS + 5_000),
			now,
		});
		expect(res.allowed).toBe(false);
		expect(res.reason).toBe("stale");
	});
});
