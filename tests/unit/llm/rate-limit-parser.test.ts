/**
 * P1365-AC1: Rate-limit header parser tests
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRateLimitHeaders } from "../../../src/infra/llm/rate-limit-parser.ts";

describe("parseRateLimitHeaders", () => {
	const now = new Date("2026-05-22T10:00:00Z");

	describe("Anthropic headers", () => {
		it("should parse valid Anthropic rate-limit headers", () => {
			const headers = {
				"anthropic-ratelimit-requests-limit": "100",
				"anthropic-ratelimit-requests-remaining": "95",
				"anthropic-ratelimit-tokens-limit": "1000000",
				"anthropic-ratelimit-tokens-remaining": "950000",
				"anthropic-ratelimit-tokens-reset": "1747996800",
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);

			assert.notEqual(signal, null);
			assert.equal(signal!.provider, "anthropic");
			assert.equal(signal!.model, "claude-opus-4");
			assert.equal(signal!.requests_limit, 100);
			assert.equal(signal!.requests_remaining, 95);
			assert.equal(signal!.tokens_limit, 1000000);
			assert.equal(signal!.tokens_remaining, 950000);
			assert.deepEqual(signal!.reset_at, new Date(1747996800 * 1000));
			assert.deepEqual(signal!.sampled_at, now);
		});

		it("should handle case-insensitive headers", () => {
			const headers = {
				"ANTHROPIC-RATELIMIT-REQUESTS-LIMIT": "100",
				"Anthropic-RateLimit-Requests-Remaining": "95",
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.notEqual(signal, null);
			assert.equal(signal!.requests_limit, 100);
			assert.equal(signal!.requests_remaining, 95);
		});

		it("should return null when no rate-limit headers present", () => {
			const headers = { "content-type": "application/json" };
			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.equal(signal, null);
		});

		it("should skip missing optional headers", () => {
			const headers = {
				"anthropic-ratelimit-requests-limit": "100",
				"anthropic-ratelimit-requests-remaining": "50",
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.notEqual(signal, null);
			assert.equal(signal!.requests_limit, 100);
			assert.equal(signal!.requests_remaining, 50);
			assert.equal(signal!.tokens_limit, null);
			assert.equal(signal!.tokens_remaining, null);
			assert.equal(signal!.reset_at, null);
		});

		it("should handle malformed timestamp", () => {
			const headers = {
				"anthropic-ratelimit-requests-remaining": "50",
				"anthropic-ratelimit-tokens-reset": "invalid-timestamp",
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.notEqual(signal, null);
			assert.equal(signal!.reset_at, null);
		});
	});

	describe("OpenAI headers", () => {
		it("should parse valid OpenAI rate-limit headers", () => {
			const headers = {
				"x-ratelimit-limit-requests": "100",
				"x-ratelimit-remaining-requests": "99",
				"x-ratelimit-limit-tokens": "2000000",
				"x-ratelimit-remaining-tokens": "1999000",
				"x-ratelimit-reset-requests": "2026-05-22T10:01:00Z",
			};

			const signal = parseRateLimitHeaders("openai", headers, "gpt-4", now);

			assert.notEqual(signal, null);
			assert.equal(signal!.provider, "openai");
			assert.equal(signal!.requests_limit, 100);
			assert.equal(signal!.requests_remaining, 99);
			assert.equal(signal!.tokens_limit, 2000000);
			assert.equal(signal!.tokens_remaining, 1999000);
			assert.deepEqual(signal!.reset_at, new Date("2026-05-22T10:01:00Z"));
		});

		it("should return null when no OpenAI headers present", () => {
			const headers = { "content-type": "application/json" };
			const signal = parseRateLimitHeaders("openai", headers, "gpt-4", now);
			assert.equal(signal, null);
		});
	});

	describe("Google/Gemini", () => {
		it("should return null for Google (no success-path headers)", () => {
			const headers = { "content-type": "application/json" };
			const signal = parseRateLimitHeaders("google", headers, "gemini-pro", now);
			assert.equal(signal, null);
		});
	});

	describe("GitHub/Copilot", () => {
		it("should return null for GitHub (Phase 2)", () => {
			const headers = { "x-ratelimit-remaining": "100" };
			const signal = parseRateLimitHeaders("github", headers, "gpt-4-turbo", now);
			assert.equal(signal, null);
		});
	});

	describe("Unknown provider", () => {
		it("should return null for unknown provider", () => {
			const signal = parseRateLimitHeaders(
				"unknown-provider" as any,
				{ "some-header": "value" },
				"model-x",
				now,
			);
			assert.equal(signal, null);
		});
	});

	describe("Malformed values", () => {
		it("should skip non-numeric values for integer fields", () => {
			const headers = {
				"anthropic-ratelimit-requests-limit": "not-a-number",
				"anthropic-ratelimit-requests-remaining": "50",
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.notEqual(signal, null);
			assert.equal(signal!.requests_limit, null);
			assert.equal(signal!.requests_remaining, 50);
		});
	});

	describe("Array header values", () => {
		it("should handle array-valued headers by taking first element", () => {
			const headers = {
				"anthropic-ratelimit-requests-remaining": ["50", "60"],
			};

			const signal = parseRateLimitHeaders("anthropic", headers, "claude-opus-4", now);
			assert.notEqual(signal, null);
			assert.equal(signal!.requests_remaining, 50);
		});
	});
});
