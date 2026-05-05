/**
 * Minimal heartbeat writer — upserts agent_health so the fleet is observable.
 * Call pulseHeartbeat() from any long-running process (orchestrator, agency, message agent).
 */

import { query } from "../postgres/pool.ts";

export async function pulseHeartbeat(
	agentIdentity: string,
	opts: {
		currentTask?: string;
		activeModel?: string;
		uptimeSeconds?: number;
		metadata?: Record<string, unknown>;
	} = {},
): Promise<void> {
	await query(
		`INSERT INTO roadmap_workforce.agent_health
		 (agent_identity, last_heartbeat_at, status, current_task, active_model, uptime_seconds, metadata)
		 VALUES ($1, now(), 'healthy', $2, $3, $4, $5::jsonb)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		     last_heartbeat_at = now(),
		     status            = 'healthy',
		     current_task      = COALESCE($2, agent_health.current_task),
		     active_model      = COALESCE($3, agent_health.active_model),
		     uptime_seconds    = $4,
		     metadata          = agent_health.metadata || $5::jsonb`,
		[
			agentIdentity,
			opts.currentTask ?? null,
			opts.activeModel ?? null,
			opts.uptimeSeconds ?? null,
			JSON.stringify(opts.metadata ?? {}),
		],
	);
}
