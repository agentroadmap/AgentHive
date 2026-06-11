/**
 * P1018: Per-CLI adapter interface for extracting token usage from spawn output.
 *
 * Each agent CLI (Claude, Codex, Gemini, Copilot) emits usage information in
 * different formats. This module provides a standard interface that each
 * provider implements, plus a fallback estimator when extraction fails.
 *
 * Design:
 * - Single CliUsageAdapter interface (extract method + provider marker)
 * - Per-provider implementations (Claude, Codex, Gemini, Copilot)
 * - Fallback estimator (estimated cost when extraction returns NULL)
 * - Factory function to select adapter by provider
 *
 * Mitigates fragility: adapters are heavily unit-tested against production
 * fixtures; when a provider changes output format, only one adapter needs to
 * be updated.
 */

export interface SpawnUsage {
	/**
	 * Input tokens consumed (cached reads count separately in cache_read_tokens).
	 * May be NULL if extraction failed and no fallback applies.
	 */
	input_tokens: number | null;
	/** Output tokens generated. */
	output_tokens: number | null;
	/** Cache creation tokens (e.g., claude prompt caching). */
	cache_creation_tokens: number | null;
	/** Cache read tokens (e.g., claude prompt caching). */
	cache_read_tokens: number | null;
	/**
	 * Source designation: 'real' (extracted from provider) or 'estimated'
	 * (calculated fallback when extraction failed).
	 * The cost_usd field is only valid when cost_source = 'real'.
	 */
	cost_source: "real" | "estimated";
	/** Computed cost in USD. Based on model_metadata.cost_per_*_tokens. */
	cost_usd: number | null;
	/**
	 * Original provider quota_remaining (if emitted).
	 * Used to populate agent_usage_snapshot.quota_remaining.
	 */
	quota_remaining: number | null;
	quota_limit: number | null;
	quota_reset_at: string | null; // ISO string
	/** Raw provider headers/metadata (for audit trail). */
	raw_metadata: Record<string, unknown> | null;
}

/**
 * Standard adapter interface for extracting usage from CLI spawn output.
 * Each provider implements one CliUsageAdapter.
 */
export interface CliUsageAdapter {
	/** Provider identifier (anthropic, openai, google, copilot). */
	readonly provider: string;

	/**
	 * Extract token usage from raw spawn output (stdout/stderr/sidecar).
	 * Returns NULL values if extraction fails for any field.
	 * Caller is responsible for applying fallback estimator on NULL result.
	 *
	 * Args:
	 *  - stdout: raw stdout from the spawned CLI
	 *  - stderr: raw stderr from the spawned CLI
	 *  - metadata: additional structured metadata (e.g., parsed sidecar JSON)
	 *
	 * Returns:
	 *  - SpawnUsage with extracted values, or partial (NULLs) if fields absent
	 *  - cost_source = 'real' if extracted; caller sets cost_source='estimated'
	 *    after fallback
	 */
	extract(
		stdout: string,
		stderr: string,
		metadata?: Record<string, unknown>,
	): SpawnUsage;
}

/**
 * Claude CLI adapter — parses stream-json format final result event.
 *
 * Claude with --output-format=stream-json emits a final result event:
 *   {"type":"message_end","message":{"usage":{"input_tokens":...,"output_tokens":...}}}
 *
 * Additional fields added by streaming cost extensions (P1018 expects
 * claude-cli >=0.15.0 which emits them).
 */
export class ClaudeCliAdapter implements CliUsageAdapter {
	readonly provider = "anthropic";

	extract(
		stdout: string,
		stderr: string,
		_metadata?: Record<string, unknown>,
	): SpawnUsage {
		// In stream-json mode, the final result is a complete JSON event.
		// Multiple events may be emitted; we want the last one (message_end with usage).
		const lines = stdout.split("\n");
		let lastMessageEnd: Record<string, unknown> | null = null;

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.type === "message_end") {
					lastMessageEnd = obj;
				}
			} catch {
				// Not valid JSON, skip
			}
		}

		if (!lastMessageEnd) {
			return {
				input_tokens: null,
				output_tokens: null,
				cache_creation_tokens: null,
				cache_read_tokens: null,
				cost_source: "real",
				cost_usd: null,
				quota_remaining: null,
				quota_limit: null,
				quota_reset_at: null,
				raw_metadata: null,
			};
		}

		const usage = (lastMessageEnd.message as Record<string, unknown>)
			?.usage as Record<string, unknown> | undefined;
		if (!usage) {
			return {
				input_tokens: null,
				output_tokens: null,
				cache_creation_tokens: null,
				cache_read_tokens: null,
				cost_source: "real",
				cost_usd: null,
				quota_remaining: null,
				quota_limit: null,
				quota_reset_at: null,
				raw_metadata: null,
			};
		}

		return {
			input_tokens:
				typeof usage.input_tokens === "number" ? usage.input_tokens : null,
			output_tokens:
				typeof usage.output_tokens === "number" ? usage.output_tokens : null,
			cache_creation_tokens:
				typeof usage.cache_creation_input_tokens === "number"
					? usage.cache_creation_input_tokens
					: null,
			cache_read_tokens:
				typeof usage.cache_read_input_tokens === "number"
					? usage.cache_read_input_tokens
					: null,
			cost_source: "real",
			cost_usd: null, // Populated by cost calculator
			quota_remaining: null, // Not available in stream-json
			quota_limit: null,
			quota_reset_at: null,
			raw_metadata: { usage },
		};
	}
}

/**
 * Codex/OpenAI CLI adapter — parses sidecar log or stdout summary.
 *
 * Codex writes usage to ~/.codex/sessions/<id>/usage.jsonl (newline-delimited JSON).
 * Each line is a usage event: {"tokens_in": N, "tokens_out": M, ...}
 *
 * Fallback: if sidecar unavailable, parse the final summary line from stdout:
 *   "Completed code execution. Tokens used: in=500 out=123"
 */
export class CodexCliAdapter implements CliUsageAdapter {
	readonly provider = "openai";

	extract(
		stdout: string,
		stderr: string,
		metadata?: Record<string, unknown>,
	): SpawnUsage {
		// Attempt 1: read sidecar metadata if provided
		if (metadata?.usage_log) {
			const usageLog = metadata.usage_log as Record<string, unknown>;
			if (
				typeof usageLog.tokens_in === "number" &&
				typeof usageLog.tokens_out === "number"
			) {
				return {
					input_tokens: usageLog.tokens_in,
					output_tokens: usageLog.tokens_out,
					cache_creation_tokens: null,
					cache_read_tokens: null,
					cost_source: "real",
					cost_usd: null,
					quota_remaining:
						typeof usageLog.quota_remaining === "number"
							? usageLog.quota_remaining
							: null,
					quota_limit:
						typeof usageLog.quota_limit === "number"
							? usageLog.quota_limit
							: null,
					quota_reset_at:
						typeof usageLog.quota_reset_at === "string"
							? usageLog.quota_reset_at
							: null,
					raw_metadata: usageLog,
				};
			}
		}

		// Attempt 2: parse stdout for "Tokens used: in=X out=Y" pattern
		const tokenMatch = /Tokens used:\s*in=(\d+)\s*out=(\d+)/i.exec(stdout);
		if (tokenMatch) {
			return {
				input_tokens: parseInt(tokenMatch[1], 10),
				output_tokens: parseInt(tokenMatch[2], 10),
				cache_creation_tokens: null,
				cache_read_tokens: null,
				cost_source: "real",
				cost_usd: null,
				quota_remaining: null,
				quota_limit: null,
				quota_reset_at: null,
				raw_metadata: { parsed_from_stdout: true },
			};
		}

		return {
			input_tokens: null,
			output_tokens: null,
			cache_creation_tokens: null,
			cache_read_tokens: null,
			cost_source: "real",
			cost_usd: null,
			quota_remaining: null,
			quota_limit: null,
			quota_reset_at: null,
			raw_metadata: null,
		};
	}
}

/**
 * Gemini CLI adapter — parses stderr usage block.
 *
 * Gemini CLI emits to stderr:
 *   "Tokens used: in=500 out=123"
 *   (and may include cache read/write tokens in extended format)
 */
export class GeminiCliAdapter implements CliUsageAdapter {
	readonly provider = "google";

	extract(
		_stdout: string,
		stderr: string,
		_metadata?: Record<string, unknown>,
	): SpawnUsage {
		// Parse stderr for "Tokens used: in=X out=Y" (and optional cache fields)
		const tokenMatch = /Tokens used:\s*in=(\d+)\s*out=(\d+)/i.exec(stderr);
		if (!tokenMatch) {
			return {
				input_tokens: null,
				output_tokens: null,
				cache_creation_tokens: null,
				cache_read_tokens: null,
				cost_source: "real",
				cost_usd: null,
				quota_remaining: null,
				quota_limit: null,
				quota_reset_at: null,
				raw_metadata: null,
			};
		}

		const result: SpawnUsage = {
			input_tokens: parseInt(tokenMatch[1], 10),
			output_tokens: parseInt(tokenMatch[2], 10),
			cache_creation_tokens: null,
			cache_read_tokens: null,
			cost_source: "real",
			cost_usd: null,
			quota_remaining: null,
			quota_limit: null,
			quota_reset_at: null,
			raw_metadata: { parsed_from_stderr: true },
		};

		// Check for cache fields
		const cacheMatch = /cache_creation_tokens=(\d+)|cache_read_tokens=(\d+)/gi;
		let match;
		while ((match = cacheMatch.exec(stderr)) !== null) {
			if (match[1]) {
				result.cache_creation_tokens = parseInt(match[1], 10);
			}
			if (match[2]) {
				result.cache_read_tokens = parseInt(match[2], 10);
			}
		}

		return result;
	}
}

/**
 * Copilot/OpenAI-compatible CLI adapter — parses response headers.
 *
 * Copilot returns rate-limit headers:
 *   x-ratelimit-remaining-tokens: N
 *   x-ratelimit-limit-tokens: M
 *   x-ratelimit-reset-tokens: <ISO string>
 *
 * Token usage in body (if available).
 */
export class CopilotCliAdapter implements CliUsageAdapter {
	readonly provider = "copilot";

	extract(
		stdout: string,
		_stderr: string,
		metadata?: Record<string, unknown>,
	): SpawnUsage {
		// Headers typically come in metadata as raw_headers
		const headers =
			metadata?.headers ||
			(metadata?.raw_headers as Record<string, unknown>) ||
			{};

		const quotaRemaining =
			typeof headers["x-ratelimit-remaining-tokens"] === "string"
				? parseInt(headers["x-ratelimit-remaining-tokens"] as string, 10)
				: typeof headers["x-ratelimit-remaining-tokens"] === "number"
					? headers["x-ratelimit-remaining-tokens"]
					: null;

		const quotaLimit =
			typeof headers["x-ratelimit-limit-tokens"] === "string"
				? parseInt(headers["x-ratelimit-limit-tokens"] as string, 10)
				: typeof headers["x-ratelimit-limit-tokens"] === "number"
					? headers["x-ratelimit-limit-tokens"]
					: null;

		const quotaResetAt =
			typeof headers["x-ratelimit-reset-tokens"] === "string"
				? headers["x-ratelimit-reset-tokens"]
				: null;

		// Try to extract token usage from response body
		let inputTokens: number | null = null;
		let outputTokens: number | null = null;
		try {
			const body = JSON.parse(stdout) as Record<string, unknown>;
			const usage = body.usage as Record<string, unknown> | undefined;
			if (usage) {
				inputTokens =
					typeof usage.prompt_tokens === "number"
						? usage.prompt_tokens
						: null;
				outputTokens =
					typeof usage.completion_tokens === "number"
						? usage.completion_tokens
						: null;
			}
		} catch {
			// Not JSON or no usage block
		}

		return {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_creation_tokens: null,
			cache_read_tokens: null,
			cost_source: "real",
			cost_usd: null,
			quota_remaining: quotaRemaining,
			quota_limit: quotaLimit,
			quota_reset_at: quotaResetAt as string | null,
			raw_metadata: headers,
		};
	}
}

/**
 * Factory function to get the appropriate adapter by provider name.
 *
 * Falls back to a null adapter that returns partial/NULL usage if the
 * provider is unknown (graceful degradation).
 */
export function getCliUsageAdapter(provider: string): CliUsageAdapter {
	switch ((provider || "").toLowerCase()) {
		case "anthropic":
		case "claude":
			return new ClaudeCliAdapter();
		case "openai":
		case "codex":
			return new CodexCliAdapter();
		case "google":
		case "gemini":
			return new GeminiCliAdapter();
		case "copilot":
		case "github":
			return new CopilotCliAdapter();
		default:
			// Null adapter for unknown providers
			return {
				provider,
				extract: () => ({
					input_tokens: null,
					output_tokens: null,
					cache_creation_tokens: null,
					cache_read_tokens: null,
					cost_source: "real",
					cost_usd: null,
					quota_remaining: null,
					quota_limit: null,
					quota_reset_at: null,
					raw_metadata: null,
				}),
			};
	}
}

/**
 * Fallback estimator: when adapter extraction returns NULL, estimate cost
 * based on wall-clock time and model's expected TPM.
 *
 * Formula: (duration_ms / 60_000) * model.expected_tpm → tokens
 *          (tokens / 1_000_000) * model.cost_per_million_input → cost_usd
 *
 * Returns NULL if model pricing unavailable (graceful: no cost recorded is
 * better than a wildly wrong estimate).
 */
export function estimateTokensAndCost(
	durationMs: number,
	model: { expected_tpm?: number; cost_per_million_input?: number } | null,
): { tokens: number | null; cost_usd: number | null } {
	if (!model) {
		return { tokens: null, cost_usd: null };
	}

	const tpm = model.expected_tpm ?? 0;
	const costPerMillion = model.cost_per_million_input ?? 0;

	if (tpm <= 0 || costPerMillion <= 0) {
		return { tokens: null, cost_usd: null };
	}

	const durationMinutes = durationMs / 60_000;
	const estimatedTokens = Math.round(durationMinutes * tpm);
	const estimatedCost = (estimatedTokens / 1_000_000) * costPerMillion;

	return { tokens: estimatedTokens, cost_usd: estimatedCost };
}
