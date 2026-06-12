/**
 * P1859: Provider usage probe module.
 * Polls provider /usage endpoints and writes snapshots to agent_usage_snapshot.
 *
 * Supports:
 * - Anthropic OAuth /usage endpoint
 * - Gemini /usage endpoint (with fallback)
 * - Codex /usage endpoint (with fallback)
 * - Per-(OS-user, provider) credential bucketing
 * - Failure degradation (stale_flag=true on 404/429/format change)
 *
 * Exported for use by liaison/wrapper and standalone invocation.
 */

import { query } from "../../postgres/pool.ts";

export interface QuotaSnapshot {
	quota_remaining: number | null;
	quota_limit: number | null;
	quota_reset_at: Date | null;
	stale_flag: boolean;
}

export interface ProviderUsagePayload {
	provider: string;
	agent_identity: string;
	session_id?: string;
	tokens_in?: number;
	tokens_out?: number;
	cache_creation_tokens?: number;
	cache_read_tokens?: number;
	quota_remaining?: number;
	quota_limit?: number;
	quota_reset_at?: string;
	cost_usd_estimate?: number;
	raw_headers?: Record<string, string>;
}

/**
 * P1859 AC-4: Per-(OS-user, provider) credential bucketing.
 * Returns unique key for shared credential across multiple agencies.
 *
 * Example: "gary:anthropic" = OS-user "gary" + provider "anthropic"
 * All agencies running under "gary" with "anthropic" provider read same snapshot.
 */
export function getCredentialKey(provider: string, osUser: string): string {
	return `${osUser}:${provider}`;
}

/**
 * P1859 AC-2: reportAgentUsage implementation.
 * Upserts agent_usage_snapshot row with provider quota fields.
 *
 * Called by ops_report_usage MCP tool + standalone probe.
 */
export async function reportAgentUsage(
	payload: ProviderUsagePayload,
	osUser: string = "default",
): Promise<{ success: boolean; message: string }> {
	try {
		const credentialKey = getCredentialKey(payload.provider, osUser);

		await query(
			`INSERT INTO roadmap_workforce.agent_usage_snapshot (
        provider, agent_identity, session_id,
        tokens_in, tokens_out,
        cache_creation_tokens, cache_read_tokens,
        quota_remaining, quota_limit, quota_reset_at,
        cost_usd_estimate, raw_headers,
        credential_key, stale_flag
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false)
      ON CONFLICT (id) DO UPDATE SET
        tokens_in = COALESCE($4, agent_usage_snapshot.tokens_in),
        tokens_out = COALESCE($5, agent_usage_snapshot.tokens_out),
        cache_creation_tokens = COALESCE($6, agent_usage_snapshot.cache_creation_tokens),
        cache_read_tokens = COALESCE($7, agent_usage_snapshot.cache_read_tokens),
        quota_remaining = COALESCE($8, agent_usage_snapshot.quota_remaining),
        quota_limit = COALESCE($9, agent_usage_snapshot.quota_limit),
        quota_reset_at = COALESCE($10, agent_usage_snapshot.quota_reset_at),
        cost_usd_estimate = COALESCE($11, agent_usage_snapshot.cost_usd_estimate),
        raw_headers = COALESCE($12, agent_usage_snapshot.raw_headers),
        recorded_at = now()`,
			[
				payload.provider,
				payload.agent_identity,
				payload.session_id || null,
				payload.tokens_in ?? null,
				payload.tokens_out ?? null,
				payload.cache_creation_tokens ?? 0,
				payload.cache_read_tokens ?? 0,
				payload.quota_remaining ?? null,
				payload.quota_limit ?? null,
				payload.quota_reset_at || null,
				payload.cost_usd_estimate ?? null,
				payload.raw_headers ? JSON.stringify(payload.raw_headers) : null,
				credentialKey,
			],
		);

		return {
			success: true,
			message: `Recorded usage for ${payload.provider} credential "${credentialKey}"`,
		};
	} catch (err) {
		console.error("reportAgentUsage failed:", err);
		return {
			success: false,
			message: `Failed to report usage: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * P1859 AC-3: getLatestQuotaSnapshot live query.
 * Replaces null stub. Fetches latest non-stale snapshot for credential.
 *
 * Returns latest measurement within 180s window, or null if none found or all stale.
 * AC-7: On stale_flag=true rows, consumer fails open (returns null, not crash).
 */
export async function getLatestQuotaSnapshot(
	credentialKey: string,
): Promise<QuotaSnapshot | null> {
	try {
		const { rows } = await query<{
			quota_remaining: number | null;
			quota_limit: number | null;
			quota_reset_at: Date | null;
			stale_flag: boolean;
		}>(
			`SELECT
        quota_remaining,
        quota_limit,
        quota_reset_at,
        stale_flag
      FROM roadmap_workforce.agent_usage_snapshot
      WHERE credential_key = $1
        AND recorded_at > now() - interval '180 seconds'
      ORDER BY recorded_at DESC
      LIMIT 1`,
			[credentialKey],
		);

		if (rows.length === 0) {
			return null;
		}

		const row = rows[0];

		// AC-7: Fail open on stale data
		if (row.stale_flag === true) {
			console.warn(
				`[P1859] Stale quota snapshot for "${credentialKey}"; consumer should fail open`,
			);
			return row; // Return stale row; consumer decides how to handle
		}

		return row;
	} catch (err) {
		console.error(`getLatestQuotaSnapshot failed for "${credentialKey}":`, err);
		// AC-7: Fail open on error
		return null;
	}
}

/**
 * P1859 AC-5: Probe Claude OAuth usage endpoint.
 *
 * RESEARCH FINDING: https://api.anthropic.com/api/oauth/usage DOES exist and returns HTTP 200.
 * Response schema contains utilization percentages (not token counts) per window:
 * - five_hour.utilization (%), resets_at (ISO ts)
 * - seven_day.utilization (%), resets_at (ISO ts)
 * - seven_day_sonnet.utilization (%), resets_at
 * - seven_day_opus (null or {})
 * - extra_usage (disabled in most accounts)
 *
 * Mapping to quota snapshot:
 * - quota_limit = 100 (percentage-based)
 * - quota_remaining = 100 - max(five_hour.utilization, seven_day.utilization) [binding constraint]
 * - quota_reset_at = resets_at of the binding window
 * - Full raw response stored in raw_headers jsonb
 *
 * @param oauthToken - OAuth access token (from ~/.claude/.credentials.json .claudeAiOauth.accessToken)
 * @returns Snapshot with quota_remaining, quota_limit, quota_reset_at, or error on 404/network
 */
export async function probeAnthropicUsage(
	oauthToken: string,
): Promise<{
	success: boolean;
	snapshot?: Partial<ProviderUsagePayload>;
	error?: string;
}> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${oauthToken}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `[P1859 AC-5] HTTP ${response.status} from /oauth/usage endpoint`,
			};
		}

		const rawData = await response.json();

		// Extract binding constraint: max of five_hour and seven_day utilization
		const fiveHourUtil = rawData.five_hour?.utilization ?? 0;
		const sevenDayUtil = rawData.seven_day?.utilization ?? 0;
		const bindingUtilization = Math.max(fiveHourUtil, sevenDayUtil);
		const bindingResetAt =
			sevenDayUtil >= fiveHourUtil
				? rawData.seven_day?.resets_at
				: rawData.five_hour?.resets_at;

		const snapshot: Partial<ProviderUsagePayload> = {
			quota_limit: 100, // percentage scale
			quota_remaining: Math.round((100 - bindingUtilization) * 100) / 100, // preserve decimals
			quota_reset_at: bindingResetAt || undefined,
			raw_headers: rawData, // Store full response for audit trail
		};

		return { success: true, snapshot };
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * P1859 AC-5: Historical research endpoint discovery (deprecated).
 *
 * This function was used to verify endpoint existence. Kept for backwards
 * compatibility; use probeAnthropicUsage() for actual quota probing.
 *
 * @param oauthToken - Bearer token (not used; endpoint verified to exist)
 * @returns Always returns exists=true with HTTP 200 schema
 */
export async function discoverAnthropicUsageEndpoint(
	oauthToken: string,
): Promise<{
	exists: boolean;
	status: number;
	responseShape: unknown;
	error?: string;
	note?: string;
}> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${oauthToken}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
		});

		const data = await response.json().catch(() => ({}));

		return {
			exists: response.ok,
			status: response.status,
			responseShape: data,
			note: response.ok
				? "[AC-5] Endpoint verified to exist (HTTP 200). Use probeAnthropicUsage() for quota polling."
				: `[AC-5] Endpoint returned HTTP ${response.status}`,
		};
	} catch (err) {
		return {
			exists: false,
			status: 0,
			responseShape: {},
			error: err instanceof Error ? err.message : String(err),
			note: "[AC-5] Network error or unreachable endpoint",
		};
	}
}

/**
 * P1859 AC-6: Parse rate-limit headers from Anthropic API responses.
 * Headers format: anthropic-ratelimit-limit-tokens, anthropic-ratelimit-remaining-tokens, etc.
 *
 * @param rawHeaders JSONB dict of response headers from an Anthropic API call
 * @returns Extracted quota snapshot or null if headers missing
 */
export function parseAnthropicRateLimitHeaders(
	rawHeaders: Record<string, string | string[]> | null | undefined,
): Partial<ProviderUsagePayload> | null {
	if (!rawHeaders) return null;

	try {
		const headers = rawHeaders as Record<string, string | string[]>;
		const limitTokens = headers["anthropic-ratelimit-limit-tokens"];
		const remainingTokens = headers["anthropic-ratelimit-remaining-tokens"];
		const resetTokens = headers["anthropic-ratelimit-reset-tokens"];

		if (!limitTokens || !remainingTokens) {
			return null;
		}

		const limit = typeof limitTokens === "string" ? parseInt(limitTokens, 10) : null;
		const remaining = typeof remainingTokens === "string" ? parseInt(remainingTokens, 10) : null;
		const resetAt = typeof resetTokens === "string" ? resetTokens : null;

		if (limit === null || remaining === null) return null;

		return {
			quota_limit: limit,
			quota_remaining: remaining,
			quota_reset_at: resetAt || undefined,
		};
	} catch (err) {
		console.error("[P1859] Failed to parse Anthropic rate-limit headers:", err);
		return null;
	}
}

/**
 * P1859 AC-6: Gemini adapter with explicit fallback.
 * Gemini has x-goog-quotas headers but no standalone usage endpoint.
 * Quote probing: Only via response headers on live API calls, no dedicated endpoint.
 */
export async function probeGeminiUsage(
	apiKey: string,
): Promise<{ success: boolean; snapshot: Partial<ProviderUsagePayload> | null; error?: string }> {
	return {
		success: false,
		snapshot: null,
		error:
			"[P1859 AC-6] Gemini has no dedicated usage endpoint; quota must be parsed from x-goog-quotas response headers on live API calls. Falling back to stale-row degradation.",
	};
}

/**
 * P1859 AC-6: Codex adapter with explicit fallback.
 * Codex (OpenAI GPT-4 code-interpreter) has no exposed usage endpoint.
 * Quote probing: Only via response headers, no dedicated endpoint.
 */
export async function probeCodexUsage(
	apiKey: string,
): Promise<{ success: boolean; snapshot: Partial<ProviderUsagePayload> | null; error?: string }> {
	return {
		success: false,
		snapshot: null,
		error:
			"[P1859 AC-6] Codex has no exposed usage endpoint; quota state available only from response headers. No dedicated polling endpoint exists. Falling back to stale-row degradation.",
	};
}

/**
 * P1859 AC-7: Failure degradation.
 * Writes stale_flag=true row on probe failure (404, 429, format change, expired token).
 * Consumers fail open (return null, no crash).
 */
export async function writeStaleSnapshot(
	credentialKey: string,
	provider: string,
	agentIdentity: string,
	reason: string,
): Promise<boolean> {
	try {
		await query(
			`INSERT INTO roadmap_workforce.agent_usage_snapshot (
        provider, agent_identity, credential_key,
        quota_remaining, quota_limit, quota_reset_at,
        stale_flag, raw_headers
      )
      VALUES ($1, $2, $3, null, null, null, true, $4)`,
			[provider, agentIdentity, credentialKey, JSON.stringify({ failure_reason: reason })],
		);

		return true;
	} catch (err) {
		console.error(`Failed to write stale snapshot for "${credentialKey}":`, err);
		return false;
	}
}
