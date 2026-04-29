/**
 * P208: Channel Identity Mapper
 *
 * Maps external platform identities (Discord user IDs, Telegram handles, etc.)
 * to internal AgentHive agent identities with trust tiers.
 *
 * DB table: roadmap_messaging.channel_identities
 *   channel         — platform name ("discord", "telegram", "slack")
 *   external_id     — platform-specific user ID
 *   external_handle — human-readable handle (@username)
 *   agent_identity  — mapped internal agent identity
 *   trust_tier      — default "restricted", upgraded on verification
 *   verified        — whether the identity has been confirmed
 *   mapped_by       — who created this mapping
 *   expires_at      — optional TTL for temporary mappings
 */

import { query } from "../postgres/pool.ts";
import type { TrustTier } from "../trust/trust-model.ts";
import { DEFAULT_TIER } from "../trust/trust-model.ts";

export class ExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExpiredError";
	}
}

export interface ChannelIdentity {
	id: number;
	channel: string;
	externalId: string;
	externalHandle: string | null;
	agentIdentity: string;
	trustTier: TrustTier;
	verified: boolean;
	mappedBy: string;
	createdAt: Date;
	expiresAt: Date | null;
}

export interface MapIdentityRequest {
	/** Platform name: "discord", "telegram", "slack", etc. */
	channel: string;
	/** Platform-specific user ID (e.g., Discord snowflake) */
	externalId: string;
	/** Human-readable handle (e.g., "@username") */
	externalHandle?: string;
	/** Internal agent identity to map to */
	agentIdentity: string;
	/** Trust tier to assign (default: restricted) */
	trustTier?: TrustTier;
	/** Who is creating this mapping */
	mappedBy: string;
	/** Optional expiration */
	expiresAt?: Date;
}

/**
 * Map an external channel identity to an internal agent identity.
 *
 * Creates or updates the channel_identities row.
 * New mappings default to "restricted" trust unless explicitly set.
 *
 * @returns The created/updated ChannelIdentity
 */
export async function mapChannelIdentity(
	req: MapIdentityRequest,
): Promise<ChannelIdentity> {
	const tier = req.trustTier ?? DEFAULT_TIER;

	const result = await query<{
		id: number;
		channel: string;
		external_id: string;
		external_handle: string | null;
		agent_identity: string;
		trust_tier: string;
		verified: boolean;
		mapped_by: string;
		created_at: Date;
		expires_at: Date | null;
	}>(
		`INSERT INTO channel_identities
		  (channel, external_id, external_handle, agent_identity, trust_tier, mapped_by, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (channel, external_id)
		 DO UPDATE SET
		   external_handle = COALESCE(EXCLUDED.external_handle, channel_identities.external_handle),
		   agent_identity = EXCLUDED.agent_identity,
		   trust_tier = EXCLUDED.trust_tier,
		   mapped_by = EXCLUDED.mapped_by,
		   expires_at = EXCLUDED.expires_at
		 RETURNING *`,
		[
			req.channel,
			req.externalId,
			req.externalHandle ?? null,
			req.agentIdentity,
			tier,
			req.mappedBy,
			req.expiresAt ?? null,
		],
	);

	return hydrateIdentity(result.rows[0]);
}

/**
 * Resolve an external channel identity to its internal agent identity.
 *
 * Looks up the channel_identities table and returns the mapping if it exists
 * and hasn't expired.
 *
 * @returns The ChannelIdentity or null if not found/expired
 */
export async function resolveChannelIdentity(
	channel: string,
	externalId: string,
): Promise<ChannelIdentity | null> {
	const result = await query<{
		id: number;
		channel: string;
		external_id: string;
		external_handle: string | null;
		agent_identity: string;
		trust_tier: string;
		verified: boolean;
		mapped_by: string;
		created_at: Date;
		expires_at: Date | null;
	}>(
		`SELECT * FROM channel_identities
		 WHERE channel = $1
		   AND external_id = $2`,
		[channel, externalId],
	);

	if (result.rows.length === 0) return null;

	const row = result.rows[0];
	if (row.expires_at && new Date(row.expires_at) <= new Date()) {
		throw new ExpiredError(
			`Channel identity ${channel}:${externalId} has expired`,
		);
	}

	return hydrateIdentity(row);
}

/**
 * List all channel identities for a given agent.
 */
export async function listAgentChannelIdentities(
	agentIdentity: string,
): Promise<ChannelIdentity[]> {
	const result = await query<{
		id: number;
		channel: string;
		external_id: string;
		external_handle: string | null;
		agent_identity: string;
		trust_tier: string;
		verified: boolean;
		mapped_by: string;
		created_at: Date;
		expires_at: Date | null;
	}>(
		`SELECT * FROM channel_identities
		 WHERE agent_identity = $1
		   AND (expires_at IS NULL OR expires_at > now())
		 ORDER BY created_at DESC`,
		[agentIdentity],
	);

	return result.rows.map(hydrateIdentity);
}

/**
 * Verify a channel identity (mark as confirmed).
 * Upgrades trust tier from restricted to known by default.
 */
export async function verifyChannelIdentity(
	channel: string,
	externalId: string,
	verifiedBy: string,
	newTier?: TrustTier,
): Promise<ChannelIdentity | null> {
	const tier = newTier ?? "known";
	const result = await query<{
		id: number;
		channel: string;
		external_id: string;
		external_handle: string | null;
		agent_identity: string;
		trust_tier: string;
		verified: boolean;
		mapped_by: string;
		created_at: Date;
		expires_at: Date | null;
	}>(
		`UPDATE channel_identities
		 SET verified = true, trust_tier = $3, mapped_by = $4
		 WHERE channel = $1 AND external_id = $2
		 RETURNING *`,
		[channel, externalId, tier, verifiedBy],
	);

	if (result.rows.length === 0) return null;
	return hydrateIdentity(result.rows[0]);
}

/**
 * Remove a channel identity mapping.
 */
export async function unmapChannelIdentity(
	channel: string,
	externalId: string,
): Promise<boolean> {
	const result = await query(
		"DELETE FROM channel_identities WHERE channel = $1 AND external_id = $2",
		[channel, externalId],
	);
	return (result.rowCount ?? 0) > 0;
}

/** Hydrate DB row to ChannelIdentity */
function hydrateIdentity(row: any): ChannelIdentity {
	return {
		id: row.id,
		channel: row.channel,
		externalId: row.external_id,
		externalHandle: row.external_handle,
		agentIdentity: row.agent_identity,
		trustTier: row.trust_tier as TrustTier,
		verified: row.verified,
		mappedBy: row.mapped_by,
		createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
		expiresAt: row.expires_at
			? row.expires_at instanceof Date
				? row.expires_at
				: new Date(row.expires_at)
			: null,
	};
}
