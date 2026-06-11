/**
 * Unit tests for CLI usage adapters (P1018).
 *
 * Tests each adapter against production fixture outputs to verify:
 * 1. Extraction of token counts from provider-specific formats
 * 2. Cache token handling (where supported)
 * 3. Quota signal capture (where available)
 * 4. Graceful fallback when extraction fails
 */

import { describe, it, expect } from "bun:test";
import {
	ClaudeCliAdapter,
	CodexCliAdapter,
	GeminiCliAdapter,
	CopilotCliAdapter,
	getCliUsageAdapter,
	estimateTokensAndCost,
} from "./cli-usage-adapter.ts";

describe("ClaudeCliAdapter", () => {
	const adapter = new ClaudeCliAdapter();

	it("extracts usage from stream-json format", () => {
		const stdout = `{"type":"content_block_start","index":0,"content_block":{"type":"text"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
{"type":"message_end","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}`;

		const result = adapter.extract(stdout, "");

		expect(result.input_tokens).toBe(100);
		expect(result.output_tokens).toBe(50);
		expect(result.cache_creation_tokens).toBe(0);
		expect(result.cache_read_tokens).toBe(0);
		expect(result.cost_source).toBe("real");
	});

	it("handles missing message_end gracefully", () => {
		const stdout = `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`;

		const result = adapter.extract(stdout, "");

		expect(result.input_tokens).toBeNull();
		expect(result.output_tokens).toBeNull();
		expect(result.cost_source).toBe("real");
	});

	it("extracts cache tokens when present", () => {
		const stdout = `{"type":"message_end","message":{"usage":{"input_tokens":500,"output_tokens":200,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}`;

		const result = adapter.extract(stdout, "");

		expect(result.cache_creation_tokens).toBe(100);
		expect(result.cache_read_tokens).toBe(50);
	});
});

describe("CodexCliAdapter", () => {
	const adapter = new CodexCliAdapter();

	it("extracts from stdout summary line", () => {
		const stdout = `Writing file...
Completed code execution. Tokens used: in=500 out=123`;

		const result = adapter.extract(stdout, "");

		expect(result.input_tokens).toBe(500);
		expect(result.output_tokens).toBe(123);
		expect(result.cost_source).toBe("real");
	});

	it("extracts from metadata sidecar", () => {
		const metadata = {
			usage_log: {
				tokens_in: 750,
				tokens_out: 200,
				quota_remaining: 50000,
				quota_limit: 100000,
				quota_reset_at: "2026-06-10T23:00:00Z",
			},
		};

		const result = adapter.extract("", "", metadata);

		expect(result.input_tokens).toBe(750);
		expect(result.output_tokens).toBe(200);
		expect(result.quota_remaining).toBe(50000);
		expect(result.quota_limit).toBe(100000);
	});

	it("returns null when no tokens found", () => {
		const stdout = "Command completed without output";

		const result = adapter.extract(stdout, "");

		expect(result.input_tokens).toBeNull();
		expect(result.output_tokens).toBeNull();
	});
});

describe("GeminiCliAdapter", () => {
	const adapter = new GeminiCliAdapter();

	it("extracts from stderr block", () => {
		const stderr = `Processing prompt...
Tokens used: in=320 out=89`;

		const result = adapter.extract("", stderr);

		expect(result.input_tokens).toBe(320);
		expect(result.output_tokens).toBe(89);
		expect(result.cost_source).toBe("real");
	});

	it("extracts cache tokens from stderr", () => {
		const stderr = `Tokens used: in=400 out=100 cache_creation_tokens=50 cache_read_tokens=25`;

		const result = adapter.extract("", stderr);

		expect(result.input_tokens).toBe(400);
		expect(result.output_tokens).toBe(100);
		expect(result.cache_creation_tokens).toBe(50);
		expect(result.cache_read_tokens).toBe(25);
	});

	it("returns null when no tokens in stderr", () => {
		const stderr = "Error: authentication failed";

		const result = adapter.extract("", stderr);

		expect(result.input_tokens).toBeNull();
	});
});

describe("CopilotCliAdapter", () => {
	const adapter = new CopilotCliAdapter();

	it("extracts usage from response body", () => {
		const stdout = JSON.stringify({
			choices: [{ message: { content: "Hello" } }],
			usage: {
				prompt_tokens: 200,
				completion_tokens: 75,
			},
		});

		const result = adapter.extract(stdout, "");

		expect(result.input_tokens).toBe(200);
		expect(result.output_tokens).toBe(75);
	});

	it("extracts quota from headers", () => {
		const metadata = {
			headers: {
				"x-ratelimit-remaining-tokens": "45000",
				"x-ratelimit-limit-tokens": "100000",
				"x-ratelimit-reset-tokens": "2026-06-11T00:00:00Z",
			},
		};

		const result = adapter.extract("", "", metadata);

		expect(result.quota_remaining).toBe(45000);
		expect(result.quota_limit).toBe(100000);
		expect(result.quota_reset_at).toBe("2026-06-11T00:00:00Z");
	});
});

describe("getCliUsageAdapter", () => {
	it("returns ClaudeCliAdapter for anthropic", () => {
		const adapter = getCliUsageAdapter("anthropic");
		expect(adapter.provider).toBe("anthropic");
	});

	it("returns CodexCliAdapter for openai", () => {
		const adapter = getCliUsageAdapter("openai");
		expect(adapter.provider).toBe("openai");
	});

	it("returns GeminiCliAdapter for google", () => {
		const adapter = getCliUsageAdapter("google");
		expect(adapter.provider).toBe("google");
	});

	it("returns CopilotCliAdapter for copilot", () => {
		const adapter = getCliUsageAdapter("copilot");
		expect(adapter.provider).toBe("copilot");
	});

	it("returns a null adapter for unknown provider", () => {
		const adapter = getCliUsageAdapter("unknown");
		const result = adapter.extract("", "");
		expect(result.input_tokens).toBeNull();
	});
});

describe("estimateTokensAndCost", () => {
	it("estimates tokens from duration and TPM with pricing", () => {
		const model = { expected_tpm: 6000, cost_per_million_input: 3000 };
		const result = estimateTokensAndCost(60000, model); // 1 minute

		expect(result.tokens).toBe(6000);
	});

	it("returns null when cost pricing missing", () => {
		const model = { expected_tpm: 6000 };
		const result = estimateTokensAndCost(60000, model);

		expect(result.tokens).toBeNull();
	});

	it("returns null for zero TPM", () => {
		const model = { expected_tpm: 0, cost_per_million_input: 3000 };
		const result = estimateTokensAndCost(60000, model);

		expect(result.tokens).toBeNull();
	});

	it("returns null for null model", () => {
		const result = estimateTokensAndCost(60000, null);

		expect(result.tokens).toBeNull();
		expect(result.cost_usd).toBeNull();
	});

	it("calculates cost from estimated tokens", () => {
		const model = {
			expected_tpm: 6000,
			cost_per_million_input: 3, // $3 per 1M tokens
		};
		const result = estimateTokensAndCost(60000, model);

		// 1 min at 6000 TPM = 6000 tokens
		// 6000 tokens at $3/1M = (6000 / 1_000_000) * 3 = $0.018
		expect(result.tokens).toBe(6000);
		expect(result.cost_usd).toBeCloseTo(0.018, 5);
	});
});
