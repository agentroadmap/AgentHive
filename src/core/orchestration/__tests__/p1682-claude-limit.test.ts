/**
 * P1682: Claude-CLI usage-limit detection → cooldown → auto-wake.
 *
 * Real assertions against the actual classifier (not substring checks): the live
 * bug was that the claude CLI prints "usage limit reached" (SPACE) while detection
 * only matched "usage_limit" (UNDERSCORE), so the limit classified as `failed` and
 * no cooldown was ever written. These tests exercise the exported pure functions.
 */

import { describe, it, expect, mock } from "bun:test";

const queryMock = mock(async () => ({ rows: [], rowCount: 0 }));
mock.module("../../../infra/postgres/pool.ts", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));

import { detectProviderQuotaSignal, classifyExit } from "../agent-spawner.ts";
import { setCliFamilyCooldown } from "../provider-cooldown.ts";

describe("P1682: claude-CLI usage-limit detection", () => {
	it("detects 'Claude AI usage limit reached' (space, not underscore) as provider=claude", () => {
		const sig = detectProviderQuotaSignal(
			"Claude AI usage limit reached. Please try again later.",
			"",
		);
		expect(sig).not.toBeNull();
		expect(sig!.provider).toBe("claude");
	});

	it("parses the exact reset from the 'usage limit reached|<epoch>' format", () => {
		const epochSec = Math.floor(Date.now() / 1000) + 3 * 3600; // 3h out
		const sig = detectProviderQuotaSignal(
			`Claude AI usage limit reached|${epochSec}`,
			"",
		);
		expect(sig).not.toBeNull();
		expect(sig!.provider).toBe("claude");
		// resetAt should be within 2s of the parsed epoch (no fallback used)
		expect(Math.abs(sig!.resetAt.getTime() - epochSec * 1000)).toBeLessThan(2000);
	});

	it("falls back to the configured window for '5-hour limit reached' (no exact time)", () => {
		const before = Date.now();
		const sig = detectProviderQuotaSignal("5-hour limit reached", "");
		expect(sig).not.toBeNull();
		expect(sig!.provider).toBe("claude");
		// default fallback is 30m; assert it is a near-future time, not epoch/NaN
		const deltaMin = (sig!.resetAt.getTime() - before) / 60000;
		expect(deltaMin).toBeGreaterThan(1);
		expect(deltaMin).toBeLessThan(24 * 60);
	});

	it("does NOT collide with the Anthropic API 'usage_limit' (underscore) branch", () => {
		const sig = detectProviderQuotaSignal(
			"Error: Your account has hit the usage_limit for this API key.",
			"",
		);
		expect(sig).not.toBeNull();
		// underscore form is the API path → provider=anthropic, NOT claude
		expect(sig!.provider).toBe("anthropic");
	});

	it("classifyExit maps a claude-CLI limit (nonzero exit) to rate_limited + quotaErrorProvider=claude", () => {
		const cls = classifyExit("Claude AI usage limit reached", "", 1);
		expect(cls.outcome).toBe("rate_limited");
		expect(cls.quotaErrorProvider).toBe("claude");
		expect(cls.resetAt instanceof Date).toBe(true);
	});

	it("classifyExit returns completed on exit 0 even if stdout mentions a limit", () => {
		const cls = classifyExit("done; note: usage limit reached yesterday", "", 0);
		expect(cls.outcome).toBe("completed");
	});
});

describe("P1682: account-wide cooldown targets the claude CLI route family", () => {
	it("setCliFamilyCooldown cools WHERE agent_cli = $1 with GREATEST merge", async () => {
		queryMock.mockClear();
		await setCliFamilyCooldown("claude", 30, "usage limit reached");
		expect(queryMock).toHaveBeenCalled();
		const call = queryMock.mock.calls[queryMock.mock.calls.length - 1];
		expect(call[0]).toContain("agent_cli = $1");
		expect(call[0]).toContain("GREATEST");
		expect(call[0]).toContain("model_routes");
		expect(call[1]).toEqual(["claude"]);
	});
});
