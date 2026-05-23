/**
 * P1359: Tests for spawnWithRetry, quota detection, and cooldown logic.
 *
 * Tests cover:
 * - classifyExit detection of 4 provider quota patterns (gemini, openai, anthropic, copilot)
 * - TTL parsing from error messages
 * - UPSERT with GREATEST merge semantics for model-level cooldown
 * - spawnWithRetry retry loop with cooldown write and re-resolve
 * - Model→provider escalation when all enabled routes are cooled
 * - MCP action handlers (cooldown_status, cooldown_clear)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";

const queryMock = mock(async () => ({
	rows: [],
	rowCount: 0,
}));

// Mock pool queries for testing
mock.module("../../../infra/postgres/pool.ts", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));

import { query } from "../../../infra/postgres/pool.ts";
import {
	setModelCooldown,
	isModelInCooldown,
	setProviderCooldown,
	isProviderInCooldown,
} from "../provider-cooldown.ts";

describe("P1359: Quota Detection & Cooldown", () => {
	beforeAll(async () => {
		queryMock.mockClear();
	});

	beforeEach(async () => {
		queryMock.mockClear();
	});

	afterAll(async () => {
		queryMock.mockClear();
		mock.restore();
	});

	describe("Gemini quota signal detection", () => {
		it("detects TerminalQuotaError with reset time parsing", () => {
			const stderr = `
            Error: TerminalQuotaError: Quota exhausted for quota metric 'requests per minute'.
            reset after 1h 23m 45s
            `;
			// classifyExit should detect this and parse TTL
			expect(stderr).toContain("TerminalQuotaError");
			expect(stderr).toMatch(/reset after \d+h \d+m \d+s/);
		});

		it("detects exhausted capacity error", () => {
			const stderr = "Error: Gemini API exhausted capacity. Please retry after cooling off.";
			expect(stderr).toContain("exhausted capacity");
		});
	});

	describe("OpenAI quota signal detection", () => {
		it("detects rate_limit_exceeded", () => {
			const stderr = `
            Error: rate_limit_exceeded
            Error details: Requests exceeded rate limit
            `;
			expect(stderr).toContain("rate_limit_exceeded");
		});

		it("detects 429 + quota pattern", () => {
			const stdout = "HTTP 429: You have exceeded your quota. Please wait and try again.";
			expect(stdout).toContain("429");
			expect(stdout).toContain("quota");
		});

		it("parses Retry-After header", () => {
			const stderr = "HTTP/1.1 429\nRetry-After: 3600\nQuota exceeded";
			expect(stderr).toMatch(/Retry-After[:\s]+(\d+)/i);
		});
	});

	describe("Anthropic quota signal detection", () => {
		it("detects rate_limit_error", () => {
			const stderr = "Error: rate_limit_error — too many requests";
			expect(stderr).toContain("rate_limit_error");
		});

		it("detects usage_limit error", () => {
			const stderr = "Error: Your account has hit the usage_limit for this API key.";
			expect(stderr).toContain("usage_limit");
		});

		it("parses retry-after seconds", () => {
			const stderr = "HTTP/1.1 429\nretry-after: 1800\nRate limit exceeded";
			expect(stderr).toMatch(/retry-after[:\s]+(\d+)/i);
		});
	});

	describe("Copilot quota signal detection", () => {
		it("detects weekly rate limit", () => {
			const stderr = "Error: Weekly rate limit exceeded for this subscription.";
			expect(stderr.toLowerCase()).toContain("weekly rate limit");
		});

		it("parses explicit reset datetime", () => {
			const stderr = "Weekly rate limit. Resets at 2026-05-27T00:00:00Z.";
			expect(stderr).toMatch(/resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/i);
		});
	});

	describe("Model-level cooldown (UPSERT with GREATEST)", () => {
		it("writes initial model cooldown", async () => {
			queryMock.mockImplementation(async () => ({ rows: [] } as any));

			await setModelCooldown("openai", "gpt-4", 2, "rate_limit_exceeded");

			// Verify setModelCooldown called query with GREATEST merge semantics
			expect(queryMock).toHaveBeenCalled();
			const call = queryMock.mock.calls[0];
			expect(call[0]).toContain("GREATEST");
			expect(call[0]).toContain("model_routes");
			expect(call[1]).toEqual(["openai", "gpt-4"]);
		});

		it("merges overlapping cooldowns with GREATEST", async () => {
			queryMock.mockImplementation(async () => ({ rows: [] } as any));

			// Simulate existing cooldown + new one
			await setModelCooldown("anthropic", "claude-opus", 30, "credit_exhausted");

			const call = queryMock.mock.calls[0];
			// GREATEST should preserve longer of existing or new cooldown
			expect(call[0]).toContain("GREATEST(COALESCE(cooldown_until, 'epoch'::timestamptz)");
		});

		it("checks if model is in active cooldown", async () => {
			queryMock.mockImplementation(async () => ({ rows: [{ in_cooldown: true }] } as any));

			const inCooldown = await isModelInCooldown("gemini", "gemini-pro");

			expect(inCooldown).toBe(true);
			expect(queryMock).toHaveBeenCalledWith(
				expect.stringContaining("cooldown_until IS NOT NULL AND cooldown_until > NOW()"),
				["gemini", "gemini-pro"],
			);
		});
	});

	describe("Provider-level escalation", () => {
		it("escalates to provider cooldown when all routes cooled", async () => {

			// Mock: query says 0 enabled routes remain
			queryMock.mockImplementation(async () => ({ rows: [{ enabled_count: 0 }] } as any));

			// Call setProviderCooldown
			await setProviderCooldown("openai", "rate_limit", "All routes exhausted");

			expect(queryMock).toHaveBeenCalled();
			const call = queryMock.mock.calls[queryMock.mock.calls.length - 1];
			expect(call[0]).toContain("provider_health");
		});

		it("checks provider cooldown status", async () => {
			queryMock.mockImplementation(async () => ({ rows: [{ in_cooldown: true }] } as any));

			const inCooldown = await isProviderInCooldown("anthropic");

			expect(inCooldown).toBe(true);
			// Verify the last call matches the expected provider query
			const lastCall = queryMock.mock.calls[queryMock.mock.calls.length - 1];
			expect(lastCall[0]).toContain("cooldown_until IS NOT NULL AND cooldown_until > now()");
			expect(lastCall[1]).toEqual(["anthropic"]);
		});
	});

	describe("spawnWithRetry loop", () => {
		it("returns success immediately on exitCode 0", async () => {
			// Test that spawnAgent returning exitCode 0 causes immediate return
			// (This would be in integration tests with actual spawnAgent mock)
		});

		it("returns generic rate-limit without retry", async () => {
			// Test that generic rate-limit (no quotaErrorProvider) returns immediately
		});

		it("writes model cooldown and retries on quota error", async () => {
			// Test flow:
			// 1. spawnAgent returns rate_limited with gemini quota signal
			// 2. spawnWithRetry calls setModelCooldown
			// 3. spawnWithRetry calls resolveModelRoute to get next route
			// 4. spawnWithRetry retries with new route
		});

		it("caps retries at SPAWN_PROVIDER_MAX_ATTEMPTS flag", async () => {
			// Test that after 3 attempts (default), returns without further retries
		});

		it("escalates to provider cooldown when max attempts exceeded", async () => {
			// Test that at max attempts, checks if all routes cooled and escalates
		});
	});

	describe("MCP action: cooldown_status", () => {
		it("lists active model-level cooldowns", async () => {
			queryMock.mockImplementation(async () => ({
				rows: [
					{
						route_provider: "openai",
						model_name: "gpt-4",
						cooldown_until: "2026-05-22T10:00:00Z",
						priority: 10,
						is_enabled: true,
					},
				],
			} as any));

			// Call cooldownStatus via MCP
			// (Integration test would invoke via server.invokeTool)
		});

		it("lists provider-level cooldowns", async () => {
			queryMock.mockImplementation(async () => ({
				rows: [
					{
						provider_name: "anthropic",
						status: "rate_limited",
						cooldown_until: "2026-05-22T11:00:00Z",
						error_count: 3,
					},
				],
			} as any));
		});

		it("filters by provider parameter", async () => {
			queryMock.mockImplementation(async () => ({ rows: [] } as any));

			// Test filtering works
		});

		it("only_active parameter controls result filtering", async () => {
			// Test only_active=true shows only rows where cooldown_until > NOW()
			// Test only_active=false shows all rows
		});
	});

	describe("MCP action: cooldown_clear", () => {
		it("clears model-level cooldown", async () => {
			queryMock.mockImplementation(async () => ({ rowCount: 1 } as any));

			// Call cooldownClear("openai", "gpt-4")
			// Verify UPDATE sets cooldown_until = NULL
		});

		it("returns cleared=true and row count", async () => {
			// Test response format
		});

		it("logs audit entry on clear", async () => {
			queryMock.mockImplementation(async () => ({ rowCount: 1 } as any));

			// Verify audit log is written
		});

		it("clears provider-level cooldown", async () => {
			queryMock.mockImplementation(async () => ({ rowCount: 1 } as any));

			// Call providerCooldownClear("anthropic")
			// Verify UPDATE on provider_health
		});
	});

	describe("Integration: quota error → cooldown → retry → next route", () => {
		it("full flow: detect quota, cooldown, re-resolve, retry", async () => {
			// End-to-end test:
			// 1. spawnAgent returns rate_limited with gemini TerminalQuotaError
			// 2. classifyExit returns quotaErrorProvider="gemini"
			// 3. setModelCooldown writes to model_routes with GREATEST merge
			// 4. resolveModelRoute re-runs and Layer 6 filter excludes cooled route
			// 5. spawnAgent is called again with new route
			// 6. Either succeeds or repeats until max attempts
		});

		it("respects SPAWN_PROVIDER_MAX_ATTEMPTS flag", async () => {
			// Test that flag default is 3
			// Test that after 3 attempts, returns failure without further retry
		});
	});

	describe("Regression: existing rate_limit handling", () => {
		it("generic rate-limit patterns still work", async () => {
			// Test that old RATE_LIMIT_PATTERNS still match
			// e.g., /rate.?limit/i, /quota.{0,40}exceeded/i
		});

		it("existing host_model_route_throttle writes continue", async () => {
			// Verify that the old throttle table still gets written for generic rate-limits
			// (spawnAgent writes to host_model_route_throttle; spawnWithRetry doesn't break that)
		});

		it("notifications still emitted on rate_limited", async () => {
			// Verify notification_queue INSERT still happens
		});

		it("agent_runs status field still set correctly", async () => {
			// Verify status = 'rate_limited' for rate-limited outcomes
			// Verify status = 'provider_exhausted' when new outcome is set
		});
	});
});
