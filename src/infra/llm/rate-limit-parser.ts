/**
 * P1365: Rate-limit header parser
 * Extracts capacity signals from LLM API response headers
 * Supports: Anthropic, OpenAI, Google/Gemini
 */

export interface CapacitySignal {
  provider: 'anthropic' | 'openai' | 'google' | 'github';
  model: string;
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_remaining: number | null;
  tokens_limit: number | null;
  reset_at: Date | null;
  sampled_at: Date;
}

/**
 * Case-insensitive header lookup
 */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const normalizedKey = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === normalizedKey) {
      if (Array.isArray(v)) return v[0] || null;
      return v || null;
    }
  }
  return null;
}

/**
 * Safe integer parse with null fallback
 */
function parseIntOrNull(val: string | null | undefined): number | null {
  if (!val) return null;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse Unix timestamp (seconds since epoch) or RFC3339 to Date
 */
function parseTimestampOrNull(val: string | null | undefined): Date | null {
  if (!val) return null;

  // Try Unix timestamp (numeric)
  if (/^\d+$/.test(val)) {
    const ms = parseInt(val, 10) * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try RFC3339 / ISO string
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extract rate-limit signals from Anthropic headers
 * Anthropic-RateLimit-Requests-Limit, Anthropic-RateLimit-Requests-Remaining, etc.
 * Reset is Unix timestamp (seconds)
 */
function parseAnthropicHeaders(
  headers: Record<string, string | string[] | undefined>
): Partial<CapacitySignal> {
  return {
    requests_limit: parseIntOrNull(getHeader(headers, 'anthropic-ratelimit-requests-limit')),
    requests_remaining: parseIntOrNull(getHeader(headers, 'anthropic-ratelimit-requests-remaining')),
    tokens_limit: parseIntOrNull(getHeader(headers, 'anthropic-ratelimit-tokens-limit')),
    tokens_remaining: parseIntOrNull(getHeader(headers, 'anthropic-ratelimit-tokens-remaining')),
    reset_at: parseTimestampOrNull(getHeader(headers, 'anthropic-ratelimit-tokens-reset')),
  };
}

/**
 * Extract rate-limit signals from OpenAI headers
 * x-ratelimit-limit-requests, x-ratelimit-remaining-requests, etc.
 * Reset is RFC3339 timestamp
 */
function parseOpenaiHeaders(
  headers: Record<string, string | string[] | undefined>
): Partial<CapacitySignal> {
  return {
    requests_limit: parseIntOrNull(getHeader(headers, 'x-ratelimit-limit-requests')),
    requests_remaining: parseIntOrNull(getHeader(headers, 'x-ratelimit-remaining-requests')),
    tokens_limit: parseIntOrNull(getHeader(headers, 'x-ratelimit-limit-tokens')),
    tokens_remaining: parseIntOrNull(getHeader(headers, 'x-ratelimit-remaining-tokens')),
    reset_at: parseTimestampOrNull(getHeader(headers, 'x-ratelimit-reset-requests')),
  };
}

/**
 * Extract rate-limit signals from Google/Gemini headers
 * RESCOPED: Google/Gemini does not surface rate-limit headers on success responses.
 * Quota information is embedded in error responses only (HTTP 429 with body details),
 * not in response headers. True quota tracking requires:
 * - Parsing error response body (requires HTTP error interception outside SDK)
 * - Instrumenting the Gemini CLI wrapper (Phase 2, see AC-11)
 *
 * Current behavior: returns null for google provider (falls back to P1359 exit-code
 * classification, no proactive capacity throttling via P1365).
 *
 * Per P1859 precedent: explicit unsupported with documented fallback is honester
 * than fabricating header names that don't exist in the API.
 */
function parseGoogleHeaders(
  headers: Record<string, string | string[] | undefined>
): Partial<CapacitySignal> | null {
  // Google quota errors are in the error body, not headers
  // On success responses, no rate-limit headers are present
  // Deferred to Phase 2: error body parsing or HTTP proxy instrumentation
  return null;
}

/**
 * Parse rate-limit headers from LLM API response
 * Returns null if no signals present or provider unsupported
 *
 * @param provider LLM provider name
 * @param headers HTTP response headers (case-insensitive lookup supported)
 * @param model Model identifier for the signal
 * @param now Current time for deterministic testing
 */
export function parseRateLimitHeaders(
  provider: CapacitySignal['provider'],
  headers: Record<string, string | string[] | undefined>,
  model: string,
  now: Date = new Date()
): CapacitySignal | null {
  let partial: Partial<CapacitySignal> | null = null;

  switch (provider) {
    case 'anthropic':
      partial = parseAnthropicHeaders(headers);
      break;
    case 'openai':
      partial = parseOpenaiHeaders(headers);
      break;
    case 'google':
      partial = parseGoogleHeaders(headers);
      break;
    case 'github':
      // GitHub/Copilot headers are less standardized; defer to Phase 2
      return null;
    default:
      return null;
  }

  if (!partial) return null;

  // Check if we have at least one meaningful signal
  const hasSignal =
    partial.requests_remaining !== null ||
    partial.tokens_remaining !== null ||
    partial.requests_limit !== null ||
    partial.tokens_limit !== null;

  if (!hasSignal) return null;

  return {
    provider,
    model,
    requests_remaining: partial.requests_remaining ?? null,
    requests_limit: partial.requests_limit ?? null,
    tokens_remaining: partial.tokens_remaining ?? null,
    tokens_limit: partial.tokens_limit ?? null,
    reset_at: partial.reset_at ?? null,
    sampled_at: now,
  };
}
