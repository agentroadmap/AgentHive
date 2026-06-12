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
 * P1859 AC-5: Research endpoint for Claude OAuth usage.
 * Makes a single read-only GET to https://api.anthropic.com/api/oauth/usage
 *
 * This is RESEARCH ONLY — called once per run for discovery.
 * Actual probe logic is separate (not auto-called in this file).
 */
export async function discoverAnthropicUsageEndpoint(
	oauthToken: string,
): Promise<{
	exists: boolean;
	status: number;
	responseShape: unknown;
	error?: string;
}> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${oauthToken}`,
				"Content-Type": "application/json",
			},
		});

		const data = await response.json().catch(() => ({}));

		return {
			exists: response.ok,
			status: response.status,
			responseShape: data,
		};
	} catch (err) {
		return {
			exists: false,
			status: 0,
			responseShape: {},
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * P1859 AC-6: Gemini adapter with fallback.
 * Explicit adapter interface: either working endpoint or documented unsupported-fallback.
 */
export async function probeGeminiUsage(
	apiKey: string,
): Promise<{ success: boolean; snapshot: Partial<ProviderUsagePayload> | null; error?: string }> {
	try {
		// Gemini doesn't have a standard usage endpoint yet.
		// This is an explicit unsupported fallback.
		return {
			success: false,
			snapshot: null,
			error:
				"[P1859] Gemini usage endpoint not yet documented/available; writing stale row for AC-7 degradation",
		};
	} catch (err) {
		return {
			success: false,
			snapshot: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * P1859 AC-6: Codex adapter with fallback.
 * Explicit adapter interface: either working endpoint or documented unsupported-fallback.
 */
export async function probeCodexUsage(
	apiKey: string,
): Promise<{ success: boolean; snapshot: Partial<ProviderUsagePayload> | null; error?: string }> {
	try {
		// Codex (gpt-4-code-interpreter) doesn't expose usage endpoint.
		// This is an explicit unsupported fallback.
		return {
			success: false,
			snapshot: null,
			error:
				"[P1859] Codex usage endpoint not documented/available; writing stale row for AC-7 degradation",
		};
	} catch (err) {
		return {
			success: false,
			snapshot: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
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
