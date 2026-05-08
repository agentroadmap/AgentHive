/**
 * P919: Display Alias Management
 *
 * Handles alias lifecycle: claim, release, and force-reclaim with heartbeat gating.
 * AC-4: Two reclaim paths:
 *   1. Clean: target row status='inactive' → proceed without force flag
 *   2. Stuck: target row status='active' BUT last_heartbeat < now()-90s → requires force=true
 */

import { query } from "../../../infra/postgres/pool.ts";

export interface AliasReclaimOptions {
	identity: string; // agent_identity of the row holding the alias
	force?: boolean; // Required for stuck-active reclaim
}

export interface AliasReclaimResult {
	success: boolean;
	reason: "inactive_clean" | "stuck_active_force" | string;
	priorIdentity?: string;
}

export interface AliasReclaimError {
	code: "alias_owner_still_alive" | "alias_not_found" | "invalid_request";
	message: string;
}

/**
 * AC-4: Force-release an alias held by another agent.
 * Checks heartbeat gating; accepts or rejects based on force flag and agent status.
 */
export async function forceReleaseAlias(
	opts: AliasReclaimOptions,
): Promise<AliasReclaimResult | AliasReclaimError> {
	const { identity, force = false } = opts;

	if (!identity?.trim()) {
		return {
			code: "invalid_request",
			message: "identity is required",
		};
	}

	// Fetch the current holder of the alias (target is being looked up by identity)
	const targetResult = await query<{
		id: bigint;
		agent_identity: string;
		display_alias: string | null;
		status: string;
		last_heartbeat_at: string | null;
		alias_audit: any;
	}>(
		`
    SELECT
      id,
      agent_identity,
      display_alias,
      status,
      COALESCE(
        (SELECT last_heartbeat_at FROM roadmap.agency
         WHERE agency_id = roadmap_workforce.agent_registry.id),
        NULL
      ) as last_heartbeat_at,
      alias_audit
    FROM roadmap_workforce.agent_registry
    WHERE agent_identity = $1
    LIMIT 1
    `,
		[identity],
	);

	if (targetResult.rows.length === 0) {
		return {
			code: "alias_not_found",
			message: `No agent found with identity ${identity}`,
		};
	}

	const target = targetResult.rows[0];
	if (!target.display_alias) {
		return {
			success: true,
			reason: "inactive_clean",
			priorIdentity: target.agent_identity,
		};
	}

	// AC-4: Check heartbeat gating
	const isInactive = target.status === "inactive";
	const now = new Date();
	const heartbeatAt = target.last_heartbeat_at
		? new Date(target.last_heartbeat_at)
		: null;
	const isStuck =
		target.status === "active" &&
		(!heartbeatAt || now.getTime() - heartbeatAt.getTime() > 90 * 1000);

	// Clean path: inactive row
	if (isInactive) {
		await releasePriorAlias(target.id, "inactive_clean");
		return {
			success: true,
			reason: "inactive_clean",
			priorIdentity: target.agent_identity,
		};
	}

	// Stuck path: active row with stale heartbeat
	if (isStuck && force) {
		await releasePriorAlias(target.id, "stuck_active_force");
		return {
			success: true,
			reason: "stuck_active_force",
			priorIdentity: target.agent_identity,
		};
	}

	// Active and recent → reject
	if (target.status === "active" && !isStuck) {
		return {
			code: "alias_owner_still_alive",
			message: `Agent ${target.agent_identity} is still active and recently heartbeat; cannot force-release without force=true`,
		};
	}

	return {
		code: "invalid_request",
		message: "Unexpected state in alias reclaim logic",
	};
}

/**
 * Internal: Clear display_alias and record audit entry.
 */
async function releasePriorAlias(
	agentId: bigint,
	reason: "inactive_clean" | "stuck_active_force",
): Promise<void> {
	await query(
		`
    UPDATE roadmap_workforce.agent_registry
    SET
      display_alias = NULL,
      alias_audit = alias_audit || $2::jsonb
    WHERE id = $1
    `,
		[
			agentId,
			JSON.stringify([
				{
					action: "released",
					reason,
					at: new Date().toISOString(),
				},
			]),
		],
	);
}
